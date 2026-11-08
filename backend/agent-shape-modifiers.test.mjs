// An agent reaches a shape's zig zag and offset path through edit.
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

test("edit sets and animates zig zag and offset fields, and refuses them on text or with a bad join", async () => {
  const document = parseDocument(createDocument({ id: "badge", name: "badge", scenes: [createScene({ id: "main", name: "Main", width: 160, height: 120, duration: 2,
    layers: [createLayer("text", { id: "word", name: "Word", text: "hi" })] })] }));
  assert.equal((await server.api("/api/projects", { method: "POST", body: { document } })).status, 201);
  const layers = async () => (await (await server.api("/api/projects/badge")).json()).document.scenes[0].layers;
  const made = await agent("edit", { project: "badge", ops: [
    { op: "add_layer", layerType: "ellipse", name: "Badge", properties: { x: 20, y: 20, width: 80, height: 80, zigzagSize: 6, zigzagCount: 8, zigzagPoints: "smooth" } },
    { op: "update_layer", layer: "Badge", properties: { offsetAmount: 4, offsetJoin: "round" } },
    { op: "add_animation", layer: "Badge", animation: { kind: "custom", name: "Grow", start: 0, duration: 1, from: { offsetAmount: 0 }, to: { offsetAmount: 10 } } }] });
  assert.equal(made.isError, undefined, made.text);
  const badge = (await layers()).find((layer) => layer.name === "Badge");
  assert.deepEqual([badge.zigzagSize, badge.zigzagCount, badge.zigzagPoints, badge.offsetAmount, badge.offsetJoin], [6, 8, "smooth", 4, "round"]);
  assert.deepEqual(badge.animations[0].to, { offsetAmount: 10 });
  const onText = await agent("edit", { project: "badge", ops: [{ op: "update_layer", layer: "Word", properties: { zigzagSize: 4 } }] });
  assert.equal(onText.isError, true);
  assert.match(onText.text, /zig zag/);
  const badJoin = await agent("edit", { project: "badge", ops: [{ op: "update_layer", layer: "Badge", properties: { offsetJoin: "sharp" } }] });
  assert.equal(badJoin.isError, true);
  assert.match(badJoin.text, /miter/);
});
