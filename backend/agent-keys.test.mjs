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

const four = [{ t: 0, value: { x: 0, opacity: 0 } }, { t: 0.3, value: { x: 100, opacity: 1 } }, { t: 0.7, value: { x: 40, opacity: 1 }, ease: "overshoot" }, { t: 1, value: { x: 120, opacity: 0.5 } }];

test("4 keys in one op: the receipt counts them, inspect lists them, check runs, keyframes are read as keys", async () => {
  const document = parseDocument(createDocument({ id: "keys4", name: "keys4", scenes: [createScene({ id: "main", name: "Main", width: 320, height: 180, duration: 4,
    layers: [createLayer("rectangle", { id: "box", name: "Box", x: 0, y: 0, width: 40, height: 40, fill: "#e0e0e0" })] })] }));
  assert.equal((await server.api("/api/projects", { method: "POST", body: { document } })).status, 201);
  const added = await agent("edit", { project: "keys4", ops: [
    { op: "add_animation", layer: "Box", name: "Hop", start: 0, duration: 1, keys: four },
    { op: "add_layer", layerType: "rectangle", name: "Dot", properties: { x: 200, y: 100, width: 20, height: 20, fill: "#ff8800" },
      animations: [{ start: 0, duration: 1, keys: four.map((key) => ({ ...key, value: { y: 100 + key.value.x / 4 } })) }] }] });
  assert.equal(added.isError, undefined, added.text);
  assert.deepEqual(Object.values(added.data.keys), [4, 4], added.text);
  assert.ok(!added.data.fixed?.some((line) => /from\/to/.test(line)), `top-level keys are documented, not a fix: ${added.data.fixed}`);
  const box = async () => (await (await server.api("/api/projects/keys4")).json()).document.scenes[0].layers.find((layer) => layer.id === "box");
  assert.deepEqual((await box()).animations[0].keys.map((key) => key.value.x), [0, 100, 40, 120]);
  assert.match((await agent("inspect", { project: "keys4", target: "Box" })).text, /x 0→100→40→120.*4 keys t 0,0\.3,0\.7\/overshoot,1/);
  // Keyframes in scene seconds become keys; the old refusal sent agents to one animation per step.
  const framed = await agent("edit", { project: "keys4", ops: [{ op: "add_animation", layer: "Box", keyframes: [{ time: 2, x: 120 }, { time: 2.5, x: 200 }, { time: 3, x: 150 }, { time: 4, x: 160 }] }] });
  assert.equal(framed.isError, undefined, framed.text);
  assert.deepEqual(Object.values(framed.data.keys), [4]);
  const keyed = (await box()).animations.at(-1);
  assert.deepEqual([keyed.start, keyed.duration, keyed.keys.map((key) => key.t)], [2, 2, [0, 0.25, 0.5, 1]]);
  const checked = await agent("check", { project: "keys4" });
  assert.equal(checked.isError, undefined, checked.text);
  assert.doesNotMatch(checked.text, /could not run/);
});

test("the jump line for a keyed animation moves its first key, and the op it gives runs", async () => {
  const document = parseDocument(createDocument({ id: "keyjump", name: "keyjump", scenes: [createScene({ id: "main", name: "Main", width: 320, height: 180, duration: 3,
    layers: [createLayer("rectangle", { id: "box", name: "Box", x: 50, y: 0, width: 40, height: 40 })] })] }));
  assert.equal((await server.api("/api/projects", { method: "POST", body: { document } })).status, 201);
  const added = await agent("edit", { project: "keyjump", ops: [{ op: "add_animation", layer: "Box", id: "hop", start: 1, duration: 1, keys: keys(100) }] });
  const line = added.data.warnings?.find((text) => text.includes("jumps"));
  assert.ok(line, added.text);
  const ops = JSON.parse(line.slice(line.indexOf("[")));
  assert.deepEqual(ops[0].properties.keys.map((key) => key.value.x), [50, 100, 20]);
  const fixed = await agent("edit", { project: "keyjump", ops });
  assert.equal(fixed.isError, undefined, fixed.text);
});

test("steps-4 stores the steps easing with intensity 4 on animations and moves; a bare steps asks for its count", async () => {
  const document = parseDocument(createDocument({ id: "steps", name: "steps", scenes: [createScene({ id: "main", name: "Main", width: 320, height: 180, duration: 4,
    layers: [createLayer("image", { id: "shot-b", name: "shot-b", src: "/b.png", width: 320, height: 180 }),
      createLayer("image", { id: "shot-a", name: "shot-a", src: "/a.png", width: 320, height: 180 }),
      createLayer("rectangle", { id: "box", name: "Box", x: 0, y: 0, width: 20, height: 20 })] })] }));
  assert.equal((await server.api("/api/projects", { method: "POST", body: { document } })).status, 201);
  const added = await agent("edit", { project: "steps", ops: [
    { op: "add_animation", layer: "Box", id: "tick", animation: { kind: "custom", name: "Tick", start: 0, duration: 1, easing: "steps-4", from: { x: 0 }, to: { x: 90 } } },
    { op: "move", name: "zoom-blur", from: "shot-a", to: "shot-b", at: 2, ease: "steps-3" }] });
  assert.equal(added.isError, undefined, added.text);
  const layers = (await (await server.api("/api/projects/steps")).json()).document.scenes[0].layers;
  const tick = layers.find((layer) => layer.id === "box").animations[0];
  assert.deepEqual([tick.easing, tick.intensity], ["steps", 4]);
  assert.ok(layers.find((layer) => layer.id === "shot-a").animations.some((animation) => animation.easing === "steps" && animation.intensity === 3));
  for (const [op, pattern] of [
    [{ op: "add_animation", layer: "Box", animation: { kind: "custom", name: "Bare", start: 0, duration: 1, easing: "steps", from: { x: 0 }, to: { x: 9 } } }, /needs its count/],
    [{ op: "add_animation", layer: "Box", keys: [{ t: 0, value: { x: 0 }, ease: "steps-4" }, { t: 0.5, value: { x: 5 } }, { t: 1, value: { x: 9 } }] }, /intensity 4/]]) {
    const refused = await agent("edit", { project: "steps", ops: [op] });
    assert.equal(refused.isError, true);
    assert.match(refused.text, pattern);
  }
});
