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
  assert.match(swung.text, /turns about \[0, 50\]% of its box \(anchor: \[x%, y%\] of its box\)/, "the receipt names the pivot");
  const skewed = await agent("edit", { project: "pivot", ops: [{ op: "update_layer", layer: "Door", properties: { anchor: [100, 100], skewY: 12 } },
    { op: "add_animation", layer: "Door", animation: { kind: "custom", name: "Slant", start: 1, duration: 0.5, from: { skewX: 0 }, to: { skewX: 20 } } }] });
  assert.equal(skewed.isError, undefined, skewed.text);
  assert.doesNotMatch(skewed.text, /turns about/, "only a scale or turn this edit added names its pivot");
  assert.deepEqual((await layer()).anchor, [100, 100]);
  assert.equal((await layer()).skewY, 12);
  const refused = await agent("edit", { project: "pivot", ops: [{ op: "add_animation", layer: "Door", preset: "preset-fade", anchor: [0, 0] }] });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /anchor is the point a rotate or scale turns about/);
});

test("anchor on a Resize is its own anchor, and an animation's anchor on a rotate points to update_layer", async () => {
  const document = parseDocument(createDocument({ id: "grow", name: "grow", scenes: [createScene({ id: "main", name: "Main", width: 160, height: 120, duration: 2,
    layers: [createLayer("rectangle", { id: "bar", name: "Bar", x: 20, y: 20, width: 40, height: 60 })] })] }));
  assert.equal((await server.api("/api/projects", { method: "POST", body: { document } })).status, 201);
  const layer = async () => (await (await server.api("/api/projects/grow")).json()).document.scenes[0].layers[0];
  const resized = await agent("edit", { project: "grow", ops: [{ op: "add_animation", layer: "Bar", preset: "resize", anchor: "top-left", start: 0 }] });
  assert.equal(resized.isError, undefined, resized.text);
  assert.equal((await layer()).animations[0].anchor, "top-left");
  assert.equal((await layer()).anchor, undefined);
  const badName = await agent("edit", { project: "grow", ops: [{ op: "add_animation", layer: "Bar", preset: "resize", anchor: [0, 0], start: 1 }] });
  assert.match(badName.text, /anchor on a Resize is the point of the box that stays put/);
  const spun = await agent("edit", { project: "grow", ops: [{ op: "add_animation", layer: "Bar", start: 1, animation: { kind: "custom", name: "Spin", duration: 0.5, from: { rotation: 0 }, to: { rotation: 90 }, anchor: "left" } }] });
  assert.equal(spun.isError, true);
  assert.match(spun.text, /update_layer \{anchor:\[x, y\]\}/);
  const turned = await agent("edit", { project: "grow", ops: [{ op: "add_animation", layer: "Bar", preset: "rotate", start: 1, from: { rotation: 0 }, to: { rotation: 90 } }] });
  assert.equal(turned.isError, undefined, turned.text);
  const id = (await layer()).animations[1].id;
  const later = await agent("edit", { project: "grow", ops: [{ op: "update_animation", animationId: id, properties: { anchor: [0, 0] } }] });
  assert.equal(later.isError, true);
  assert.match(later.text, /update_layer \{anchor:\[x, y\]\}/);
});
