// An agent reaches text unit orders and the text loop through edit.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createDocument, createScene, parseDocument } from "../engine/model.js";
import { startTestServer } from "./media.test.support.mjs";

let server;
before(async () => { server = await startTestServer(); });
after(() => server?.stop());

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

test("edit sets a text loop and the new unit orders, and refuses a loop on a shape or a seed without random", async () => {
  const document = parseDocument(createDocument({ id: "loop", name: "loop", scenes: [createScene({ id: "main", name: "Main", width: 640, height: 360, duration: 4 })] }));
  assert.equal((await server.api("/api/projects", { method: "POST", body: { document } })).status, 201);
  const layers = async () => (await (await server.api("/api/projects/loop")).json()).document.scenes[0].layers;
  const made = await agent("edit", { project: "loop", ops: [
    { op: "add_layer", layerType: "text", name: "Title", properties: { text: "hello", x: 40, y: 100, width: 500, height: 120, textLoop: { style: "wave", amount: 10 } } },
    { op: "add_layer", layerType: "rectangle", name: "Box", properties: { x: 0, y: 0, width: 40, height: 40 } },
    { op: "add_animation", layer: "Title", preset: "preset-fade", start: 0, duration: 0.5, unit: "letters", stagger: 0.05, order: "random", orderSeed: 4 },
    { op: "add_animation", layer: "Title", preset: "preset-fade", mode: "out", start: 3, duration: 0.5, unit: "letters", stagger: 0.05, order: "center-out" }] });
  assert.equal(made.isError, undefined, made.text);
  let title = (await layers()).find((layer) => layer.name === "Title");
  assert.deepEqual(title.textLoop, { style: "wave", amount: 10 });
  assert.deepEqual(title.animations.map((animation) => [animation.order, animation.orderSeed]), [["random", 4], ["center-out", undefined]]);
  assert.equal((await agent("edit", { project: "loop", ops: [{ op: "update_layer", layer: "Title", properties: { textLoop: { style: "pulse", unit: "words", speed: 2 } } }] })).isError, undefined);
  title = (await layers()).find((layer) => layer.name === "Title");
  assert.deepEqual(title.textLoop, { style: "pulse", speed: 2, unit: "words" });
  const onBox = await agent("edit", { project: "loop", ops: [{ op: "update_layer", layer: "Box", properties: { textLoop: { style: "wave" } } }] });
  assert.equal(onBox.isError, true);
  assert.match(onBox.text, /only text layers/);
  const seeded = await agent("edit", { project: "loop", ops: [{ op: "add_animation", layer: "Title", preset: "preset-fade", start: 1, unit: "letters", stagger: 0.05, orderSeed: 2 }] });
  assert.equal(seeded.isError, true);
  assert.match(seeded.text, /orderSeed/);
  assert.equal((await agent("edit", { project: "loop", ops: [{ op: "update_layer", layer: "Title", properties: { textLoop: null } }] })).isError, undefined);
  assert.equal(Object.hasOwn((await layers()).find((layer) => layer.name === "Title"), "textLoop"), false);
});

test("edit sets jitter, a range rotation and the outlineGlow shorthand in one call each", async () => {
  const document = parseDocument(createDocument({ id: "hand", name: "hand", scenes: [createScene({ id: "main", name: "Main", width: 640, height: 360, duration: 4 })] }));
  assert.equal((await server.api("/api/projects", { method: "POST", body: { document } })).status, 201);
  const made = await agent("edit", { project: "hand", ops: [
    { op: "add_layer", layerType: "text", name: "Scrawl", properties: { text: "NOT AGAIN", x: 40, y: 100, width: 500, height: 120, fontSize: 87.5, jitter: { rotation: 4, seed: 3 }, outlineGlow: { stroke: "#FF4DD2", glow: "#FF2BD6" } } },
    { op: "add_layer", layerType: "rectangle", name: "Box", properties: { x: 0, y: 0, width: 40, height: 40, jitter: true } },
    { op: "style_text_range", layer: "Scrawl", text: "AGAIN", style: { rotation: 6, baselineShift: -4 } }] });
  assert.equal(made.isError, true, "jitter on a shape is refused");
  assert.match(made.text, /only text layers/);
  const fixed = await agent("edit", { project: "hand", ops: [
    { op: "add_layer", layerType: "text", name: "Scrawl", properties: { text: "NOT AGAIN", x: 40, y: 100, width: 500, height: 120, fontSize: 87.5, jitter: { rotation: 4, seed: 3 }, outlineGlow: { stroke: "#FF4DD2", glow: "#FF2BD6" } } },
    { op: "style_text_range", layer: "Scrawl", text: "AGAIN", style: { rotation: 6, baselineShift: -4 } }] });
  assert.equal(fixed.isError, undefined, fixed.text);
  const scrawl = (await (await server.api("/api/projects/hand")).json()).document.scenes[0].layers.find((layer) => layer.name === "Scrawl");
  assert.deepEqual(scrawl.jitter, { rotation: 4, seed: 3 });
  assert.deepEqual([scrawl.strokes[0].color, scrawl.strokes[0].width, scrawl.shadows[0].color, scrawl.fill], ["#FF4DD2", 2.5, "#FF2BD6", "#0A1F0C"]);
  assert.deepEqual(scrawl.textStyleRanges[0].style, { rotation: 6, baselineShift: -4 });
  assert.equal(Object.hasOwn(scrawl, "outlineGlow"), false);
  // On update_layer with no fontSize, the outline scales for the layer's own 87.5 px, not 175.
  assert.equal((await agent("edit", { project: "hand", ops: [{ op: "update_layer", layer: "Scrawl", properties: { outlineGlow: true } }] })).isError, undefined);
  const updated = (await (await server.api("/api/projects/hand")).json()).document.scenes[0].layers.find((layer) => layer.name === "Scrawl");
  assert.deepEqual([updated.strokes[0].width, updated.strokes[0].color], [2.5, "#1F7A29"]);
});
