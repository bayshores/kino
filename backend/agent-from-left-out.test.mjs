// A custom animation's `from` left out starts where the layer is drawn at the animation's start
// (engine/operations.js fillLeftOutFrom), and the edit receipt warns when an animation an edit added
// or changed starts more than half a pixel away from where its layer is drawn just before it
// (backend/agent/jumps.mjs). Checked on the frames the layer draws, through the agent service.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { evaluateLayer } from "../engine/animation.js";
import { startTestServer } from "./media.test.support.mjs";

let server;
before(async () => { server = await startTestServer(); });
after(async () => { await server?.stop(); });

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}
const saved = async (id) => (await server.api(`/api/projects/${id}`)).json();
const layerNamed = (record, name) => record.document.scenes.flatMap((scene) => scene.layers).find((layer) => layer.name === name);

// The biggest step in x or y between two frames 1/120 s apart, over the whole scene.
function biggestStep(layer, duration) {
  let biggest = 0;
  let previous = evaluateLayer(layer, 0);
  for (let frame = 1; frame <= duration * 120; frame += 1) {
    const state = evaluateLayer(layer, frame / 120);
    biggest = Math.max(biggest, Math.abs(state.x - previous.x), Math.abs(state.y - previous.y));
    previous = state;
  }
  return biggest;
}

async function project(id) {
  await agent("project", { action: "create", id, name: id, width: 1920, height: 1080, duration: 5 });
}

test("a second move with from left out starts where the first one left the layer, with no jump", async () => {
  await project("chain");
  const reply = await agent("edit", { project: "chain", ops: [
    { op: "add_layer", layerType: "rectangle", name: "box", properties: { x: 100, y: 400, width: 100, height: 100, fill: "#ffffff" }, animations: [
      { kind: "custom", name: "Go", start: 0, duration: 1, from: { x: 100 }, to: { x: 1600 } },
      // Before, this was saved as x 100→800, so at 2 s the box jumped from 1600 back to 100.
      { kind: "custom", name: "Back", start: 2, duration: 1, to: { x: 800, y: 300 } },
    ] },
  ] });
  assert.equal(reply.isError, undefined, reply.text);
  assert.equal(reply.data.warnings, undefined, "no jump, so no warning");
  const box = layerNamed(await saved("chain"), "box");
  const back = box.animations.find((animation) => animation.name === "Back");
  assert.deepEqual(back.from, { x: 1600, y: 400 }, "x from where Go left it, y from the layer's own place");
  assert.equal(evaluateLayer(box, 1.99).x, 1600);
  assert.equal(evaluateLayer(box, 2).x, 1600);
  assert.equal(evaluateLayer(box, 3).x, 800);
  // The fastest frame-to-frame move is the smooth travel (well under 100 px), never a 1500 px jump.
  assert.ok(biggestStep(box, 5) < 100, `biggest step ${biggestStep(box, 5)} px`);
});

test("an animation an edit adds or changes that starts away from the layer is a warning with the op that joins it", async () => {
  await project("jumps");
  const made = await agent("edit", { project: "jumps", ops: [
    { op: "add_layer", layerType: "rectangle", name: "box", properties: { x: 100, y: 400, width: 100, height: 100, fill: "#ffffff" }, animations: [
      { kind: "custom", name: "Go", start: 0, duration: 1, from: { x: 100 }, to: { x: 1600 } },
      { kind: "custom", name: "Back", start: 2, duration: 1, to: { x: 800 } },
    ] },
  ] });
  assert.equal(made.isError, undefined, made.text);
  const [go, back] = layerNamed(await saved("jumps"), "box").animations;

  // Changing where Go ends leaves Back starting at 1600 while the box is at 1200.
  const changed = await agent("edit", { project: "jumps", ops: [{ op: "update_animation", animation: go.id, properties: { to: { x: 1200 } } }] });
  assert.equal(changed.isError, undefined, changed.text);
  const line = changed.data.warnings?.find((each) => /jumps 400 px/.test(each));
  assert.ok(line, JSON.stringify(changed.data.warnings));
  assert.match(line, /\(Back\) starts at x 1600 at 2 s, but box is drawn at x 1200 just before, so it jumps 400 px\. To start where it is: /);
  const ops = JSON.parse(line.slice(line.indexOf("[")));
  assert.deepEqual(ops[0].properties, { from: { x: 1200 } });
  const fixed = await agent("edit", { project: "jumps", ops });
  assert.equal(fixed.isError, undefined, fixed.text);
  assert.equal(fixed.data.warnings, undefined, "joined: no warning");
  const box = layerNamed(await saved("jumps"), "box");
  assert.ok(biggestStep(box, 5) < 100, `after the op, biggest step ${biggestStep(box, 5)} px`);
  assert.equal(box.animations[1].id, back.id);

  // A from set far from the layer is a warning too; a jump that was there before is not repeated.
  const drop = await agent("edit", { project: "jumps", ops: [
    { op: "add_animation", layer: "box", animation: { kind: "custom", name: "Drop", start: 4, duration: 0.5, from: { y: 100 }, to: { y: 900 } } },
  ] });
  assert.match(drop.data.warnings?.join("\n") ?? "", /\(Drop\) starts at y 100 at 4 s, but box is drawn at y 400 just before, so it jumps 300 px/);
  const again = await agent("edit", { project: "jumps", ops: [{ op: "update_layer", layer: "box", properties: { fill: "#ff0000" } }] });
  assert.equal(again.data.warnings, undefined, JSON.stringify(again.data.warnings));

  // A layer held at opacity 0 by an entrance is not drawn, so a move before it (a carry's target) cannot jump.
  const ghost = await agent("edit", { project: "jumps", ops: [
    { op: "add_layer", layerType: "rectangle", name: "ghost", properties: { x: 100, y: 400, width: 100, height: 100, fill: "#ffffff" }, animations: [
      { kind: "custom", name: "Ride", start: 1, duration: 1, from: { x: 900 }, to: { x: 1000 } },
      { kind: "in", name: "Show", start: 3, duration: 0.5, from: { opacity: 0 }, to: { opacity: 1 } },
    ] },
  ] });
  assert.equal(ghost.data.warnings?.find((each) => /ghost/.test(each)), undefined, JSON.stringify(ghost.data.warnings));
});

// A preset exit's `to` is worked out from its `from` (a Slide Out ends its distance away from
// where it starts). Before, the op that joined it changed only `from`: after a drift from y 300 to
// 180, "Slide Out ↑" (y 300→238.56) became y 180→238.56 and went 58 px the other way, and after a
// 40 px drift its 40 px exit became y 260→260 and did not move at all.
test("the op that starts a preset exit where the layer is moves both its ends: it still slides its distance the same way", async () => {
  await project("exit");
  const made = await agent("edit", { project: "exit", ops: [
    { op: "add_layer", layerType: "text", name: "tag", properties: { text: "Tag", x: 300, y: 300, width: 300, height: 100, fontSize: 64, fill: "#ffffff" } },
    { op: "add_animation", layer: "tag", preset: "preset-fade", start: 0, duration: 0.5 },
    { op: "add_animation", layer: "tag", animation: { kind: "custom", name: "Drift", start: 1, duration: 2, from: { y: 300 }, to: { y: 180 } } },
    { op: "add_animation", layer: "tag", preset: "preset-slide", mode: "out", start: 4, duration: 0.5, parameters: { direction: "down", distance: 80 } },
    { op: "add_layer", layerType: "rectangle", name: "m1", properties: { x: 900, y: 300, width: 100, height: 100, fill: "#ffffff" } },
    { op: "add_animation", layer: "m1", preset: "preset-slide", start: 0.1, duration: 0.5, parameters: { direction: "up", distance: 40 } },
    { op: "add_animation", layer: "m1", animation: { kind: "custom", name: "Drift", start: 2, duration: 2, from: { y: 300 }, to: { y: 260 } } },
    { op: "add_animation", layer: "m1", preset: "preset-slide", mode: "out", start: 4.5, duration: 0.5, parameters: { direction: "down", distance: 40 } },
  ] });
  assert.equal(made.isError, undefined, made.text);
  const exitOf = (record, name) => layerNamed(record, name).animations.find((animation) => animation.kind === "out");
  const first = await saved("exit");
  const travel = Object.fromEntries(["tag", "m1"].map((name) => [name, exitOf(first, name).to.y - exitOf(first, name).from.y]));
  assert.ok(Math.abs(travel.tag) > 50 && Math.abs(travel.m1) > 30, JSON.stringify(travel));
  const lines = made.data.warnings ?? [];
  assert.equal(lines.length, 2, JSON.stringify(lines));
  assert.match(lines[0], /^tag\.out \(Slide Out ↑\) starts at y 300 at 4 s, but tag is drawn at y 180 just before, so it jumps 120 px\. To start where it is: /);
  const ops = lines.flatMap((line) => JSON.parse(line.slice(line.indexOf("[{"))));
  assert.deepEqual(ops[0].properties, { from: { y: 180 }, to: { y: Number((180 + travel.tag).toFixed(3)) } });
  const fixed = await agent("edit", { project: "exit", ops });
  assert.equal(fixed.isError, undefined, fixed.text);
  assert.equal(fixed.data.warnings, undefined, "joined: no warning");
  const record = await saved("exit");
  for (const [name, start, drift] of [["tag", 4, 180], ["m1", 4.5, 260]]) {
    const layer = layerNamed(record, name);
    const exit = exitOf(record, name);
    assert.ok(Math.abs(exit.to.y - exit.from.y - travel[name]) < 1e-3, `${name}'s exit keeps its length and direction`);
    assert.equal(evaluateLayer(layer, start - 0.01).y, drift);
    assert.equal(evaluateLayer(layer, start).y, drift, `${name} does not jump at ${start} s`);
    assert.ok(Math.abs(evaluateLayer(layer, start + 0.5).y - (drift + travel[name])) < 0.1, `${name}'s exit still moves ${travel[name]} px`);
    assert.ok(biggestStep(layer, 5) < 20, `${name}: biggest step ${biggestStep(layer, 5)} px`);
  }
});

// Changing where an entrance rests can make the custom move after it jump. Before, that receipt had
// two lines whose ops broke each other when both were sent (the entrance moved back up by 100 and
// the move started 100 lower: a new 100 px jump), and that jump was not warned because it was as
// long as the one the edit replaced, though it went the other way.
test("an entrance moved away from a chain gives one line whose ops join it, and a jump that now goes the other way is warned", async () => {
  await project("rise");
  const made = await agent("edit", { project: "rise", ops: [
    { op: "add_layer", layerType: "rectangle", name: "tag", properties: { x: 300, y: 400, width: 100, height: 100, fill: "#ffffff" }, animations: [
      { kind: "in", name: "Rise", start: 0, duration: 0.5, from: { y: 460 }, to: { y: 400 } },
      { kind: "custom", name: "Drift", start: 1, duration: 2, from: { y: 400 }, to: { y: 500 } },
      { kind: "out", name: "Leave", start: 4, duration: 0.5, from: { y: 500 }, to: { y: 600 } },
    ] },
  ] });
  assert.equal(made.isError, undefined, made.text);
  const changed = await agent("edit", { project: "rise", ops: [{ op: "update_animation", animation: "tag.in", properties: { to: { y: 300 } } }] });
  assert.equal(changed.data.warnings?.length, 1, JSON.stringify(changed.data.warnings));
  const [line] = changed.data.warnings;
  assert.match(line, /^tag y 400 does not show: from 0\.5 s tag\.in \(Rise\) holds y 300\./);
  const or = JSON.parse(line.slice(line.lastIndexOf("{\"op\"")));
  assert.deepEqual(or, { op: "update_animation", animation: "tag.in", properties: { from: { y: 560 }, to: { y: 400 } } });

  // The op the old second line gave, sent with the first line's: the move now starts 100 px above
  // where the entrance leaves the layer.
  const both = await agent("edit", { project: "rise", ops: [or, { op: "update_animation", animation: "tag.custom", properties: { from: { y: 300 } } }] });
  assert.equal(both.isError, undefined, both.text);
  assert.match(both.data.warnings?.join("\n") ?? "", /tag\.custom \(Drift\) starts at y 300 at 1 s, but tag is drawn at y 400 just before, so it jumps 100 px\. To start where it is: \[\{"op":"update_animation","animation":"tag\.custom","properties":\{"from":\{"y":400\}\}\}\]/);
  const ops = JSON.parse(both.data.warnings[0].slice(both.data.warnings[0].indexOf("[{")));
  assert.equal((await agent("edit", { project: "rise", ops })).data.warnings, undefined);
  const tag = layerNamed(await saved("rise"), "tag");
  assert.equal(evaluateLayer(tag, 0.99).y, 400);
  assert.equal(evaluateLayer(tag, 1).y, 400, "no jump at 1 s");
  assert.ok(biggestStep(tag, 5) < 20, `biggest step ${biggestStep(tag, 5)} px`);
});

// A slide exit reverses its entrance: direction up leaves downward. Its name had the direction's
// arrow ("Slide Out ↑" for y 500→540, which moves down), and the rules said only "Directions are
// up/down/left/right", so an agent that asked for an exit to the right got one to the left.
test("a slide exit's name shows the way it moves, and the preset rules say what its direction means", async () => {
  await project("leave");
  const made = await agent("edit", { project: "leave", ops: [
    { op: "add_layer", layerType: "rectangle", name: "p2", properties: { x: 100, y: 500, width: 100, height: 80, fill: "#ff0000" }, animations: [
      { preset: "preset-slide", mode: "out", start: 4, duration: 0.4, parameters: { direction: "up", distance: 50 } },
      { preset: "preset-slide", mode: "out", start: 5, duration: 0.4, parameters: { direction: "left", distance: 50 } },
    ] },
  ] });
  assert.equal(made.isError, undefined, made.text);
  const shown = await agent("inspect", { project: "leave", targets: ["p2"] });
  assert.match(shown.text, /'Slide Out ↓' out preset slide \(direction "up", distance 50\) y 500→540 /);
  assert.match(shown.text, /'Slide Out →' out preset slide \(direction "left", distance 50\) x 100→150 /);
  const rules = await agent("library", { topic: "rules", name: "presets" });
  assert.match(rules.text, /An exit reverses its entrance: a slide out with direction up leaves downward/);
  const op = await agent("library", { topic: "op", name: "add_animation" });
  assert.match(op.text, /An exit reverses its entrance: direction up leaves downward/);

  // An exit saved before the names changed keeps the direction's arrow; the rules say so, and a
  // preset change gives it the new name (its from and to were right all along).
  assert.match(rules.text, /An exit saved before 2026-10-20 may still show the direction's arrow \(Slide Out ↑ for direction up\): its from and to show the way it moves, and a preset change gives it the new name/);
  const old = await agent("edit", { project: "leave", ops: [{ op: "update_animation", animation: "p2.Slide Out ↓", properties: { name: "Slide Out ↑" } }] });
  assert.equal(old.isError, undefined, old.text);
  const renamed = await agent("edit", { project: "leave", ops: [{ op: "update_animation", animation: "p2.Slide Out ↑", properties: { preset: { parameters: { distance: 60 } } } }] });
  assert.equal(renamed.isError, undefined, renamed.text);
  const now = await agent("inspect", { project: "leave", targets: ["p2"] });
  assert.match(now.text, /'Slide Out ↓' out preset slide \(direction "up", distance 60\) y 500→548 /);
});
