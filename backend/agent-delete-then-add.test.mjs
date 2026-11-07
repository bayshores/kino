// Rebuilding part of a scene from a script deletes the old layers and adds new ones with the
// same names in one edit. While making the smokescreen promo the new layers came out as card-2
// and title-2, and a child that said parentId:"card" was refused because "card" was the deleted
// group. Now a delete earlier in an edit frees its names (with its children and animations), so
// the new layers keep the names the script gave them. Runs on a real server.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startTestServer } from "./media.test.support.mjs";

let server;
before(async () => { server = await startTestServer(); });
after(async () => { await server?.stop(); });

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

const card = (x) => [
  { op: "add_layer", layerType: "group", name: "card", properties: { x, y: 100, width: 600, height: 300 } },
  { op: "add_layer", layerType: "text", name: "title", properties: { parentId: "card", x: 20, y: 20, width: 500, height: 80, text: "Hello", fontSize: 60, fill: "#ffffff" },
    animations: [{ preset: "preset-fade", start: 0, duration: 0.4 }] },
];

test("deleting a group and adding it again in one edit keeps the names", async () => {
  await agent("project", { action: "create", id: "rebuild", name: "Rebuild", width: 1920, height: 1080, duration: 4, background: "#101010" });
  const first = await agent("edit", { project: "rebuild", ops: card(100) });
  assert.equal(first.isError, undefined, first.text);

  const again = await agent("edit", { project: "rebuild", ops: [{ op: "delete_layer", layer: "title" }, { op: "delete_layer", layer: "card" }, ...card(700)] });
  assert.equal(again.isError, undefined, again.text);
  const fields = await agent("inspect", { project: "rebuild", targets: ["card", "title"], fields: ["x", "parentId"] });
  assert.equal(fields.isError, undefined, fields.text);
  assert.doesNotMatch(fields.text, /card-2|title-2/, fields.text);
  assert.match(fields.text, /700/, fields.text);
});

test("deleting a group frees its children's names too", async () => {
  const again = await agent("edit", { project: "rebuild", ops: [{ op: "delete_layer", layer: "card" }, ...card(300)] });
  assert.equal(again.isError, undefined, again.text);
  assert.doesNotMatch(JSON.stringify(again.data ?? again.text), /card-2|title-2/, again.text);
});

test("a later operation on a deleted layer is refused with its name", async () => {
  const late = await agent("edit", { project: "rebuild", ops: [{ op: "delete_layer", layer: "card" }, { op: "update_layer", layer: "title", properties: { x: 5 } }] });
  assert.equal(late.isError, true, late.text);
  assert.match(late.text, /title/, late.text);
});

test("deleting a child after its group in the same edit is skipped, not refused", async () => {
  const both = await agent("edit", { project: "rebuild", ops: [{ op: "delete_layer", layer: "card" }, { op: "delete_layer", layer: "title" }, ...card(900)] });
  assert.equal(both.isError, undefined, both.text);
  assert.deepEqual(both.data.notes, ["title went with card (op 0): deleting a group deletes its layers, so that delete was skipped."]);
  const fields = await agent("inspect", { project: "rebuild", targets: ["title"], fields: ["parentId"] });
  assert.match(fields.text, /card/, fields.text);
});
