// An agent reaches a custom animation's keys through edit: add, change, and the refusal of a
// from/to edit that the keys would overwrite.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { startTestServer } from "./media.test.support.mjs";

let server;
before(async () => { server = await startTestServer(); });
after(() => server?.stop());

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

const keys = (middle) => [{ t: 0, value: { x: 0 } }, { t: 0.5, value: { x: middle }, ease: "overshoot" }, { t: 1, value: { x: 20 } }];

test("edit adds and changes keys, and refuses from or to on a keyed animation", async () => {
  const document = parseDocument(createDocument({ id: "keys", name: "keys", scenes: [createScene({ id: "main", name: "Main", width: 160, height: 120, duration: 2,
    layers: [createLayer("rectangle", { id: "box", name: "Box", x: 0, y: 0, width: 20, height: 20 })] })] }));
  assert.equal((await server.api("/api/projects", { method: "POST", body: { document } })).status, 201);
  const added = await agent("edit", { project: "keys", ops: [{ op: "add_animation", layer: "Box", id: "hop",
    animation: { kind: "custom", name: "Hop", start: 0, duration: 1, keys: keys(100) } }] });
  assert.equal(added.isError, undefined, added.text);
  const stored = async () => (await (await server.api("/api/projects/keys")).json()).document.scenes[0].layers[0].animations[0];
  assert.deepEqual((await stored()).keys.map((key) => key.value.x), [0, 100, 20]);
  assert.equal((await stored()).keys[1].ease, "overshoot");
  const refused = await agent("edit", { project: "keys", ops: [{ op: "update_animation", layer: "Box", animation: "hop", properties: { to: { x: 5 } } }] });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /has keys/);
  const changed = await agent("edit", { project: "keys", ops: [{ op: "update_animation", layer: "Box", animation: "hop", properties: { keys: keys(60) } }] });
  assert.equal(changed.isError, undefined, changed.text);
  assert.equal((await stored()).keys[1].value.x, 60);
});
