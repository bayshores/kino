// Component workflows are driven through the agent service and checked through saved-project look.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readImage, startTestServer } from "./media.test.support.mjs";
// These tests are about reaching features; approvals (D3) are tested in dashboard tests and
// in agent-reach-workspace's approval test, so the person here allows them.
const REACH_ALLOW = ["delete-scene", "delete-project", "share-link", "final-render", "overwrite-export", "large-import"];

let server;
before(async () => { server = await startTestServer({ allow: REACH_ALLOW }); });
after(() => server?.stop());

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers through the agent service`);
  return response.json();
}

async function createProject(id, { width = 120, height = 80, duration = 3, background = "#000000" } = {}) {
  const reply = await agent("project", { action: "create", id, name: id, width, height, duration, background });
  assert.equal(reply.isError, undefined, reply.text);
  const record = await saved(id);
  return record.document.scenes[0].id;
}

async function edit(project, ops) {
  const reply = await agent("edit", { project, ops });
  assert.equal(reply.isError, undefined, reply.text);
  return reply;
}

async function refusal(project, ops, pattern) {
  const reply = await agent("edit", { project, ops });
  assert.equal(reply.isError, true, `edit should be refused: ${reply.text}`);
  if (pattern) assert.match(reply.text, pattern);
  return reply;
}

async function saved(project) {
  const response = await server.api(`/api/projects/${project}`);
  assert.equal(response.status, 200, `project ${project} is saved`);
  return response.json();
}

async function frame(project, scene, time = 0) {
  const look = await agent("look", { project, mode: "frame", scene, t: time });
  assert.equal(look.isError, undefined, look.text);
  assert.equal(look.images?.[0]?.mime, "image/png", "look returns a rendered PNG");
  return readImage(Buffer.from(look.images[0].data, "base64"));
}

function sceneOf(record, id) {
  const scene = record.document.scenes.find((item) => item.id === id);
  assert.ok(scene, `scene ${id} exists`);
  return scene;
}

function layerOf(scene, id) {
  const layer = scene.layers.find((item) => item.id === id);
  assert.ok(layer, `layer ${id} exists in ${scene.id}`);
  return layer;
}

function compareFrames(before, after, message) {
  assert.deepEqual([after.width, after.height], [before.width, before.height]);
  for (let y = 0; y < before.height; y += 1) for (let x = 0; x < before.width; x += 1) {
    const left = before.pixel(x, y);
    const right = after.pixel(x, y);
    for (let channel = 0; channel < left.length; channel += 1)
      assert.ok(Math.abs(left[channel] - right[channel]) <= 1, `${message} at ${x},${y} channel ${channel}: ${left} → ${right}`);
  }
}

const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const BLACK = [0, 0, 0, 255];

function customMove(id, { start, duration, fromX, toX }) {
  return { id, name: id, kind: "custom", start, duration, easing: "linear", from: { x: fromX }, to: { x: toX } };
}

test("create_component_from_layers preserves fractional playback pixels through agent edit and look", async () => {
  const project = "reach-component-extract";
  const scene = await createProject(project, { width: 128, height: 72, duration: 3 });
  await edit(project, [
    { op: "add_layer", scene, layerType: "rectangle", properties: {
      id: "moving", name: "Moving", x: 9.25, y: 21, width: 28, height: 18, fill: "#ff0000",
    } },
    { op: "add_animation", scene, layer: "moving", animation: customMove("slide", { start: 0.35, duration: 1.6, fromX: 9.25, toX: 73.25 }) },
    { op: "add_layer", scene, layerType: "rectangle", properties: {
      id: "untouched", name: "Untouched", x: 100, y: 50, width: 12, height: 12, fill: "#00ff00",
    } },
  ]);

  const times = [0.2, 0.625, 1.15, 1.725, 2.4];
  const before = [];
  for (const time of times) before.push(await frame(project, scene, time));
  const result = await edit(project, [{
    op: "create_component_from_layers", scene, layers: ["moving"], name: "Moving sprite",
    componentSceneId: "moving-component", instanceId: "moving-instance",
  }]);
  assert.equal(result.isError, undefined, result.text);

  const record = await saved(project);
  const component = sceneOf(record, "moving-component");
  assert.equal(component.isComponent, true);
  assert.equal(layerOf(sceneOf(record, scene), "moving-instance").componentSceneId, component.id);
  assert.deepEqual(layerOf(component, "moving").animations.map(({ id, start, duration }) => ({ id, start, duration })), [
    { id: "slide", start: 0.35, duration: 1.6 },
  ]);
  for (let index = 0; index < times.length; index += 1)
    compareFrames(before[index], await frame(project, scene, times[index]), `component extraction preserves time ${times[index]}`);
});

test("nested override precedence, descendant path reset, inherited nudge override and history render correctly", async () => {
  const project = "reach-component-nested";
  const scene = await createProject(project, { width: 96, height: 64, duration: 2 });
  await edit(project, [
    { op: "add_scene", properties: { id: "badge", name: "Badge", width: 20, height: 20, duration: 2, background: "#00000000" } },
    { op: "add_layer", scene: "badge", layerType: "rectangle", properties: {
      id: "badge-box", name: "Badge box", x: 0, y: 0, width: 20, height: 20, fill: "#ff0000",
    } },
    { op: "create_component", scene: "badge" },
    { op: "add_scene", properties: { id: "card", name: "Card", width: 40, height: 30, duration: 2, background: "#00000000" } },
    { op: "insert_component", scene: "card", component: "badge", properties: {
      id: "badge-1", name: "Badge 1", x: 10, y: 5, componentOverrides: { "badge-box": { fill: "#00ff00" } },
    } },
    { op: "create_component", scene: "card" },
    { op: "insert_component", scene, component: "card", properties: {
      id: "card-1", name: "Card 1", x: 20, y: 15,
      componentOverrides: { "badge-1/badge-box": { fill: "#0000ff" } },
    } },
  ]);

  const overridden = await frame(project, scene);
  assert.deepEqual(overridden.pixel(31, 21), BLUE, "the outer nested path override wins over the badge's green fill");
  await edit(project, [{ op: "reset_component_overrides", scene, layer: "card-1", componentPaths: ["badge-1"] }]);
  const reset = await frame(project, scene);
  assert.deepEqual(reset.pixel(30, 20), GREEN, "resetting an instance path clears its descendant override and reveals the nested instance's own override");
  assert.deepEqual(layerOf(sceneOf(await saved(project), scene), "card-1").componentOverrides, undefined);

  const beforeNudge = reset;
  await agent("notes", { project, action: "add", text: "Keep the reset state; next edit is a separate nudge turn.", by: "you" });
  const nudge = await edit(project, [{
    op: "set_component_overrides", scene, layer: "card-1", overrides: { "badge-1/badge-box": { x: 1, y: 0 } },
  }]);
  assert.ok(nudge.data?.turn, "the inherited nudge is recorded in an agent history turn");
  const afterNudge = await frame(project, scene);
  assert.deepEqual(beforeNudge.pixel(30, 20), GREEN, "the original left edge was green");
  assert.deepEqual(afterNudge.pixel(30, 20), BLACK, "the inherited x override nudges the component one pixel right");
  assert.deepEqual(afterNudge.pixel(31, 20), GREEN, "the nudged edge is rendered from the inherited override");
  assert.deepEqual(layerOf(sceneOf(await saved(project), scene), "card-1").componentOverrides, { "badge-1/badge-box": { x: 1 } });

  const reverted = await agent("history", { project, action: "revert", turn: nudge.data.turn });
  assert.equal(reverted.isError, undefined, reverted.text);
  const afterHistory = await frame(project, scene);
  assert.deepEqual(afterHistory.pixel(30, 20), GREEN, "history revert restores the inherited component position");
  assert.deepEqual(layerOf(sceneOf(await saved(project), scene), "card-1").componentOverrides, undefined);
});

test("extraction remaps existing instance overrides and keeps component and animation clocks", async () => {
  const project = "reach-component-existing-overrides";
  const main = await createProject(project, { width: 120, height: 72, duration: 3 });
  await edit(project, [
    { op: "add_scene", properties: { id: "master", name: "Master", width: 80, height: 50, duration: 3, background: "#00000000" } },
    { op: "add_layer", scene: "master", layerType: "rectangle", properties: {
      id: "box", name: "Box", x: 8, y: 14, width: 22, height: 20, fill: "#ff0000",
    } },
    { op: "add_animation", scene: "master", layer: "box", animation: customMove("master-slide", { start: 0.4, duration: 1.25, fromX: 8, toX: 56 }) },
    { op: "create_component", scene: "master" },
    { op: "insert_component", scene: main, component: "master", properties: {
      id: "master-instance", name: "Master instance", x: 12, y: 8, componentStart: 0.2,
      componentOverrides: { box: { fill: "#0000ff", x: 18 } },
    } },
  ]);
  const times = [0.1, 0.575, 0.95, 1.55, 2.25];
  const before = [];
  for (const time of times) before.push(await frame(project, main, time));

  await edit(project, [{
    op: "create_component_from_layers", scene: "master", layers: ["box"], name: "Extracted box",
    componentSceneId: "extracted-box", instanceId: "extracted-instance",
  }]);

  const record = await saved(project);
  const master = sceneOf(record, "master");
  const extracted = sceneOf(record, "extracted-box");
  const extractedBox = layerOf(extracted, "box");
  assert.deepEqual(extractedBox.animations.map(({ id, start, duration }) => ({ id, start, duration })), [
    { id: "master-slide", start: 0.4, duration: 1.25 },
  ], "the source animation keeps its clock after extraction");
  assert.equal(layerOf(master, "extracted-instance").componentSceneId, extracted.id);
  assert.deepEqual(layerOf(sceneOf(record, main), "master-instance").componentOverrides, {
    "extracted-instance/box": { fill: "#0000ff", x: 10 },
  }, "preexisting fill override survives and local x rebases around the extracted origin");
  assert.equal(layerOf(sceneOf(record, main), "master-instance").componentStart, 0.2, "the parent instance clock is unchanged");
  for (let index = 0; index < times.length; index += 1)
    compareFrames(before[index], await frame(project, main, times[index]), `existing override pixels survive extraction at ${times[index]}`);
});

test("empty and unsafe component selections refuse atomically through agent edit", async () => {
  const project = "reach-component-refusals";
  const scene = await createProject(project, { width: 96, height: 64, duration: 2 });
  await edit(project, [
    { op: "add_layer", scene, layerType: "group", properties: { id: "faded", name: "Faded", x: 0, y: 0, width: 40, height: 40, opacity: 0.5 } },
    { op: "add_layer", scene, layerType: "rectangle", properties: { id: "inside", name: "Inside", parentId: "faded", x: 2, y: 2, width: 20, height: 20, fill: "#ff0000" } },
    { op: "add_layer", scene, layerType: "rectangle", properties: { id: "outside", name: "Outside", x: 55, y: 2, width: 20, height: 20, fill: "#00ff00" } },
  ]);
  const before = await saved(project);
  const empty = await refusal(project, [{
    op: "create_component_from_layers", scene, layers: [], name: "Empty", componentSceneId: "empty-component", instanceId: "empty-instance",
  }], /select at least one layer/i);
  assert.equal(empty.isError, true);
  assert.equal((await saved(project)).revision, before.revision, "an empty selection does not save a partial extraction");

  await refusal(project, [{
    op: "create_component_from_layers", scene, layers: ["inside", "outside"], name: "Unsafe", componentSceneId: "unsafe-component", instanceId: "unsafe-instance",
  }], /opacity/i);
  const after = await saved(project);
  assert.equal(after.revision, before.revision, "an unsafe mixed-parent selection does not save a partial extraction");
  assert.ok(!after.document.scenes.some((item) => item.id === "unsafe-component"));
});

async function addNestedComponentFixture(project, scene, rootX) {
  await edit(project, [
    { op: "add_scene", properties: { id: "shared-badge", name: "Shared badge", width: 18, height: 18, duration: 2, background: "#00000000" } },
    { op: "add_layer", scene: "shared-badge", layerType: "rectangle", properties: {
      id: "badge-shape", name: "Badge shape", x: 0, y: 0, width: 18, height: 18, fill: "#ff6b4a",
    } },
    { op: "create_component", scene: "shared-badge" },
    { op: "add_scene", properties: { id: "shared-card", name: "Shared card", width: 38, height: 30, duration: 2, background: "#00000000" } },
    { op: "insert_component", scene: "shared-card", component: "shared-badge", properties: {
      id: "badge-inside", name: "Badge inside", x: 9, y: 6,
    } },
    { op: "create_component", scene: "shared-card" },
    { op: "insert_component", scene, component: "shared-card", properties: {
      id: "card-instance", name: "Card instance", x: rootX, y: 18,
    } },
  ]);
}

test("copying a component instance between agent projects copies nested dependencies and renders the same", async () => {
  const sourceProject = "reach-component-copy-source";
  const targetProject = "reach-component-copy-target";
  const sourceScene = await createProject(sourceProject, { width: 112, height: 64, duration: 2 });
  const targetScene = await createProject(targetProject, { width: 112, height: 64, duration: 2 });
  await addNestedComponentFixture(sourceProject, sourceScene, 24);
  const sourceBefore = await frame(sourceProject, sourceScene, 0.5);
  assert.deepEqual(sourceBefore.pixel(34, 24), [255, 107, 74, 255], "the source's nested component is visible");

  await edit(targetProject, [{ op: "copy_layers", fromProject: sourceProject, fromScene: sourceScene, layers: ["card-instance"], scene: targetScene }]);
  const targetAfter = await frame(targetProject, targetScene, 0.5);
  compareFrames(sourceBefore, targetAfter, "cross-project component copy keeps the rendered result");

  const target = await saved(targetProject);
  const card = target.document.scenes.find((item) => item.id !== targetScene && item.name === "Shared card");
  const badge = target.document.scenes.find((item) => item.id !== targetScene && item.name === "Shared badge");
  assert.ok(card?.isComponent, "the copied card dependency exists as a component scene");
  assert.ok(badge?.isComponent, "the nested badge dependency exists as a component scene");
  const pasted = sceneOf(target, targetScene).layers.find((layer) => layer.type === "component");
  assert.ok(pasted, "the copied project has a component instance layer");
  assert.equal(pasted.componentSceneId, card.id);
  assert.notEqual(pasted.id, "card-instance", "copied instance IDs are fresh in the destination");
  const nested = card.layers.find((layer) => layer.type === "component");
  assert.ok(nested, "the copied card retains its nested component instance");
  assert.equal(nested.componentSceneId, badge.id, "the copied card links to its copied nested badge");
  assert.notEqual(nested.id, "badge-inside", "layers in copied component dependencies receive fresh IDs");
});
