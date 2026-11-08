// An agent reaches a layer's anchor (pivot) and skew through edit.
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

test("edit sets anchor and skewY on a layer and anchor on a rotate preset", async () => {
  const document = parseDocument(createDocument({ id: "pivot", name: "pivot", scenes: [createScene({ id: "main", name: "Main", width: 160, height: 120, duration: 2,
    layers: [createLayer("rectangle", { id: "door", name: "Door", x: 20, y: 20, width: 40, height: 60 })] })] }));
  assert.equal((await server.api("/api/projects", { method: "POST", body: { document } })).status, 201);
  const layer = async () => (await (await server.api("/api/projects/pivot")).json()).document.scenes[0].layers[0];
  const swung = await agent("edit", { project: "pivot", ops: [{ op: "add_animation", layer: "Door", preset: "rotate", anchor: "left", start: 0, duration: 1, from: { rotation: -90 }, to: { rotation: 0 } }] });
  assert.equal(swung.isError, undefined, swung.text);
  assert.deepEqual((await layer()).anchor, [0, 50]);
  const skewed = await agent("edit", { project: "pivot", ops: [{ op: "update_layer", layer: "Door", properties: { anchor: [100, 100], skewY: 12 } },
    { op: "add_animation", layer: "Door", animation: { kind: "custom", name: "Slant", start: 1, duration: 0.5, from: { skewX: 0 }, to: { skewX: 20 } } }] });
  assert.equal(skewed.isError, undefined, skewed.text);
  assert.deepEqual((await layer()).anchor, [100, 100]);
  assert.equal((await layer()).skewY, 12);
  const refused = await agent("edit", { project: "pivot", ops: [{ op: "add_animation", layer: "Door", preset: "preset-fade", anchor: [0, 0] }] });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /anchor is the point a rotate or scale turns about/);
});
