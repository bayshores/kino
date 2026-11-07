// Agent-service coverage for feature rows that are not represented by the golden scenes.
// Every mutation uses POST /api/agent/edit; rendered checks use the agent's saved-project look.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { near, readImage, startTestServer } from "./media.test.support.mjs";
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

async function createProject(id, { width = 160, height = 80, duration = 4, background = "#ffffff" } = {}) {
  const reply = await agent("project", { action: "create", id, name: id, width, height, duration, background });
  assert.equal(reply.isError, undefined, reply.text);
  return (await saved(id)).document.scenes[0].id;
}

async function edit(project, ops, options = {}) {
  const reply = await agent("edit", { project, ops, ...options });
  assert.equal(reply.isError, undefined, reply.text);
  return reply;
}

async function saved(project) {
  const response = await server.api(`/api/projects/${project}`);
  assert.equal(response.status, 200, `project ${project} is saved`);
  return response.json();
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

async function frame(project, scene, time = 0, width) {
  const record = await saved(project);
  const target = sceneOf(record, scene);
  const look = await agent("look", {
    project,
    mode: "frame",
    scene,
    t: time,
    width: width ?? target.width,
  });
  assert.equal(look.isError, undefined, look.text);
  assert.equal(look.images?.[0]?.mime, "image/png", "look returns a rendered PNG");
  return readImage(Buffer.from(look.images[0].data, "base64"));
}

function colorAt(image, x, y, color, message, tolerance = 8) {
  const actual = image.pixel(x, y);
  assert.ok(near(actual, color, tolerance), `${message}: expected ${color}, received ${actual}`);
}

function compareSamples(before, after, points, message) {
  for (const [x, y] of points) assert.deepEqual(after.pixel(x, y), before.pixel(x, y), `${message} at ${x},${y}`);
}

function differentPixelCount(before, after) {
  assert.deepEqual([before.width, before.height], [after.width, after.height]);
  let count = 0;
  for (let y = 0; y < before.height; y += 1) for (let x = 0; x < before.width; x += 1)
    if (!before.pixel(x, y).every((channel, index) => channel === after.pixel(x, y)[index])) count += 1;
  return count;
}

const WHITE = [255, 255, 255, 255];
const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];
const GREEN = [0, 255, 0, 255];

test("layer add, edit, delete, reorder, group, ungroup, reparent, align and convert preserve the rendered result", async () => {
  const project = "reach-layer-ops";
  const scene = await createProject(project, { width: 160, height: 80 });
  await edit(project, [{ op: "add_layer", scene, layerType: "rectangle", properties: {
    id: "red", name: "Red", x: 10, y: 10, width: 30, height: 30, fill: "#ff0000",
  } }, { op: "add_layer", scene, layerType: "rectangle", properties: {
    id: "blue", name: "Blue", x: 20, y: 15, width: 30, height: 30, fill: "#0000ff",
  } }, { op: "add_layer", scene, layerType: "rectangle", properties: {
    id: "green", name: "Green", x: 65, y: 10, width: 20, height: 20, fill: "#00ff00",
  } }, { op: "add_layer", scene, layerType: "rectangle", properties: {
    id: "yellow", name: "Yellow", x: 110, y: 60, width: 10, height: 10, fill: "#ffff00",
  } }]);

  const original = await frame(project, scene);
  colorAt(original, 12, 12, RED, "the red layer is visible");
  colorAt(original, 25, 20, BLUE, "the top layer wins in the overlap");
  colorAt(original, 70, 15, GREEN, "the green layer is visible");

  await edit(project, [{ op: "update_layer", scene, layer: "green", properties: { fill: "#ff0000" } }]);
  const edited = await frame(project, scene);
  colorAt(edited, 70, 15, RED, "update_layer changes the rendered fill");

  await edit(project, [{ op: "reorder_layer", scene, layer: "red", to: "front" }]);
  const reordered = await frame(project, scene);
  colorAt(reordered, 25, 20, RED, "reorder_layer changes which overlapping layer is drawn on top");
  const stablePoints = [[12, 12], [25, 20], [70, 15], [115, 65]];

  await edit(project, [{ op: "group_layers", scene, layers: ["red", "blue"], name: "Pair", groupId: "pair" }]);
  const grouped = await frame(project, scene);
  compareSamples(reordered, grouped, stablePoints, "group_layers keeps the sampled canvas appearance");
  assert.equal(layerOf(sceneOf(await saved(project), scene), "red").parentId, "pair");

  await edit(project, [{ op: "move_layers", scene, layers: ["green"], position: "top", parentId: "pair" }]);
  const reparented = await frame(project, scene);
  compareSamples(grouped, reparented, stablePoints, "move_layers keeps a reparented layer in its canvas position");
  assert.equal(layerOf(sceneOf(await saved(project), scene), "green").parentId, "pair");

  await edit(project, [{ op: "align_layers", scene, layers: ["yellow"], align: "right" }]);
  const aligned = await frame(project, scene);
  colorAt(aligned, 155, 65, [255, 255, 0, 255], "align_layers aligns a single layer to the scene edge");

  await edit(project, [{ op: "ungroup_layer", scene, layer: "pair" }]);
  const ungrouped = await frame(project, scene);
  compareSamples(aligned, ungrouped, [[12, 12], [25, 20], [70, 15], [155, 65]], "ungroup_layer preserves the sampled canvas appearance");
  assert.equal(layerOf(sceneOf(await saved(project), scene), "green").parentId, null);

  await edit(project, [{ op: "convert_to_shape", scene, layer: "red" }]);
  const converted = await frame(project, scene);
  assert.equal(layerOf(sceneOf(await saved(project), scene), "red").type, "path");
  colorAt(converted, 12, 12, RED, "convert_to_shape keeps the visible primitive pixels");

  await edit(project, [{ op: "delete_layer", scene, layer: "green" }]);
  const deleted = await frame(project, scene);
  colorAt(deleted, 70, 15, WHITE, "delete_layer removes the layer from the render");
  assert.ok(!sceneOf(await saved(project), scene).layers.some((layer) => layer.id === "green"));
});

test("mask create and remove are reachable by edit and change the actual rendered pixels", async () => {
  const project = "reach-mask-ops";
  const scene = await createProject(project, { width: 80, height: 40 });
  await edit(project, [{ op: "add_layer", scene, layerType: "rectangle", properties: {
    id: "mask", name: "Mask", x: 0, y: 0, width: 40, height: 40, fill: "#ffffff",
  } }, { op: "add_layer", scene, layerType: "rectangle", properties: {
    id: "content", name: "Content", x: 0, y: 0, width: 80, height: 40, fill: "#ff0000",
  } }]);
  const before = await frame(project, scene);
  colorAt(before, 20, 20, RED, "unmasked content is red");
  colorAt(before, 60, 20, RED, "unmasked content fills the canvas");

  await edit(project, [{ op: "create_mask", scene, layers: ["content", "mask"], maskLayerId: "mask", name: "Window", groupId: "window" }]);
  const masked = await frame(project, scene);
  colorAt(masked, 20, 20, RED, "the white mask keeps its covered pixels visible");
  colorAt(masked, 60, 20, WHITE, "the mask hides content outside its shape");
  const group = layerOf(sceneOf(await saved(project), scene), "window");
  assert.equal(group.isMaskGroup, true);

  await edit(project, [{ op: "remove_mask", scene, layer: "window" }]);
  const unmasked = await frame(project, scene);
  colorAt(unmasked, 60, 20, RED, "remove_mask restores content outside the former mask");
  assert.equal(layerOf(sceneOf(await saved(project), scene), "mask").isMask, false);
});

test("component overrides render, reset restores inheritance, and detach stops following the master", async () => {
  const project = "reach-component-ops";
  const scene = await createProject(project, { width: 120, height: 60 });
  await edit(project, [
    { op: "add_scene", properties: { id: "master", name: "Master", width: 40, height: 30, duration: 2, background: "#00000000" } },
    { op: "add_layer", scene: "master", layerType: "rectangle", properties: {
      id: "master-box", name: "Master box", x: 0, y: 0, width: 40, height: 30, fill: "#ff0000",
    } },
    { op: "create_component", scene: "master" },
    { op: "insert_component", scene, component: "master", properties: {
      id: "instance", name: "Instance", x: 40, y: 15,
    } },
    { op: "set_component_overrides", scene, layer: "instance", overrides: { "master-box": { fill: "#0000ff" } } },
  ]);
  const overridden = await frame(project, scene);
  colorAt(overridden, 45, 20, BLUE, "the per-instance fill override is rendered");
  assert.deepEqual(layerOf(sceneOf(await saved(project), scene), "instance").componentOverrides, { "master-box": { fill: "#0000ff" } });

  await edit(project, [{ op: "reset_component_overrides", scene, layer: "instance", componentPaths: ["master-box"] }]);
  const reset = await frame(project, scene);
  colorAt(reset, 45, 20, RED, "reset_component_overrides restores the source design");

  await edit(project, [
    { op: "set_component_overrides", scene, layer: "instance", overrides: { "master-box": { fill: "#0000ff" } } },
    { op: "detach_component", scene, layer: "instance" },
  ]);
  const detached = await frame(project, scene);
  colorAt(detached, 45, 20, BLUE, "detach_component keeps the overridden appearance");
  assert.ok(!sceneOf(await saved(project), scene).layers.some((layer) => layer.id === "instance" && layer.type === "component"));

  await edit(project, [{ op: "update_layer", scene: "master", layer: "master-box", properties: { fill: "#00ff00" } }]);
  const noLongerLinked = await frame(project, scene);
  colorAt(noLongerLinked, 45, 20, BLUE, "detached content no longer follows source edits");
});

function customAnimation(id, from, to, { start = 0, duration = 1 } = {}) {
  return { id, name: id, kind: "custom", start, duration, easing: "linear", from, to };
}

test("composed animation grouping, duplication, ungrouping and deletion preserve or change real pixels as specified", async () => {
  const project = "reach-composed-ops";
  const scene = await createProject(project, { width: 100, height: 60, background: "#ffffff" });
  await edit(project, [
    { op: "add_layer", scene, layerType: "rectangle", properties: {
      id: "box", name: "Box", x: 10, y: 20, width: 20, height: 20, fill: "#ff0000",
    } },
    { op: "add_animation", scene, layer: "box", animation: customAnimation("move", { x: 10, y: 20 }, { x: 50, y: 20 }) },
    { op: "add_animation", scene, layer: "box", animation: customAnimation("fade", { opacity: 1 }, { opacity: 0.5 }) },
  ]);
  const before = await frame(project, scene, 0.5);
  colorAt(before, 40, 25, [255, 64, 64, 255], "halfway through the independent tracks", 18);

  await edit(project, [{ op: "group_animations", scene, animationIds: ["move", "fade"], name: "Composed motion" }]);
  let record = await saved(project);
  const layer = layerOf(sceneOf(record, scene), "box");
  const originalGroup = layer.animations.find((animation) => animation.kind === "composed");
  assert.ok(originalGroup, "group_animations creates a Composed row");
  assert.deepEqual(new Set(originalGroup.animations.map((animation) => animation.id)), new Set(["move", "fade"]));
  const grouped = await frame(project, scene, 0.5);
  compareSamples(before, grouped, [[15, 25], [40, 25], [60, 25]], "group_animations keeps playback pixels");

  await edit(project, [{ op: "duplicate_animations", scene, animationIds: [originalGroup.id] }]);
  record = await saved(project);
  const groups = layerOf(sceneOf(record, scene), "box").animations.filter((animation) => animation.kind === "composed");
  assert.equal(groups.length, 2, "duplicate_animations creates a second composed row");
  const duplicate = groups.find((animation) => animation.id !== originalGroup.id);
  assert.ok(duplicate);
  const originalMemberIds = new Set(originalGroup.animations.map((animation) => animation.id));
  assert.ok(duplicate.animations.every((animation) => !originalMemberIds.has(animation.id)), "copied members have fresh IDs");
  compareSamples(grouped, await frame(project, scene, 0.5), [[15, 25], [40, 25], [60, 25]], "a duplicate at the same time keeps playback pixels");

  await edit(project, [{ op: "ungroup_animations", scene, animationIds: [duplicate.id] }]);
  record = await saved(project);
  const animationsAfterUngroup = layerOf(sceneOf(record, scene), "box").animations;
  assert.ok(animationsAfterUngroup.some((animation) => animation.id === originalGroup.id && animation.kind === "composed"));
  const duplicateMemberIds = duplicate.animations.map((animation) => animation.id);
  assert.ok(duplicateMemberIds.every((id) => animationsAfterUngroup.some((animation) => animation.id === id)), "ungrouping exposes the copied child operations");
  await edit(project, duplicateMemberIds.map((animationId) => ({ op: "delete_animation", scene, layer: "box", animationId })));

  await edit(project, [{ op: "ungroup_animations", scene, animationIds: [originalGroup.id] }]);
  record = await saved(project);
  assert.deepEqual(layerOf(sceneOf(record, scene), "box").animations.map((animation) => animation.id).sort(), ["fade", "move"].sort());
  await edit(project, [{ op: "delete_animation", scene, layer: "box", animationId: "fade" }]);
  record = await saved(project);
  assert.deepEqual(layerOf(sceneOf(record, scene), "box").animations.map((animation) => animation.id), ["move"]);
  const withoutFade = await frame(project, scene, 0.5);
  assert.notDeepEqual(withoutFade.pixel(40, 25), before.pixel(40, 25), "deleting a track changes the interpolated opacity pixel");
});

function startsById(record, sceneId) {
  const starts = {};
  for (const layer of sceneOf(record, sceneId).layers)
    for (const animation of layer.animations) starts[animation.id] = animation.start;
  return starts;
}

test("stagger timeline, reverse, selection, center and seeded-random orders set starts and match visible frames", async () => {
  const project = "reach-stagger-ops";
  const scene = await createProject(project, { width: 128, height: 48, duration: 3 });
  const ids = ["fade-a", "fade-b", "fade-c", "fade-d"];
  const layers = ["a", "b", "c", "d"];
  const colors = ["#ff0000", "#0000ff", "#00ff00", "#000000"];
  await edit(project, layers.map((id, index) => ({
    op: "add_layer", scene, layerType: "rectangle", properties: {
      id, name: id.toUpperCase(), x: 5 + index * 30, y: 10, width: 20, height: 20, fill: colors[index],
    },
  })).concat(ids.map((id, index) => ({
    op: "add_animation", scene, layer: layers[index], animation: { id, name: id, kind: "hide", start: 0 },
  }))));

  const itemOrder = ["fade-c", "fade-a", "fade-d", "fade-b"];
  const orders = [
    ["timeline", { "fade-a": 0, "fade-b": 0.2, "fade-c": 0.4, "fade-d": 0.6 }],
    ["reverse", { "fade-d": 0, "fade-c": 0.2, "fade-b": 0.4, "fade-a": 0.6 }],
    ["selection", { "fade-c": 0, "fade-a": 0.2, "fade-d": 0.4, "fade-b": 0.6 }],
    ["center", { "fade-b": 0, "fade-c": 0, "fade-a": 0.2, "fade-d": 0.2 }],
  ];

  for (const [order, expected] of orders) {
    await edit(project, [{ op: "update_animations", scene, animationIds: ids, properties: { start: 0 } }]);
    await edit(project, [{ op: "stagger_animations", scene, items: order === "selection" ? itemOrder : ids, delay: 0.2, order }]);
    const actual = startsById(await saved(project), scene);
    assert.deepEqual(actual, expected, `${order} order assigns the documented item slots`);
    const rendered = await frame(project, scene, 0.15);
    const hidden = Object.entries(actual).filter(([, start]) => start === 0).map(([id]) => id.replace("fade-", ""));
    for (const [index, id] of layers.entries()) {
      const point = [15 + index * 30, 20];
      if (hidden.includes(id)) colorAt(rendered, ...point, WHITE, `${order} order hides its first slot`);
      else colorAt(rendered, ...point, colors[index].match(/[a-f0-9]{2}/giu).map((part) => Number.parseInt(part, 16)).concat(255), `${order} order keeps a later slot visible`);
    }
  }

  const random = async () => {
    await edit(project, [{ op: "update_animations", scene, animationIds: ids, properties: { start: 0 } }]);
    await edit(project, [{ op: "stagger_animations", scene, items: ids, delay: 0.2, order: "random", seed: 42 }]);
    return startsById(await saved(project), scene);
  };
  const randomFirst = await random();
  assert.deepEqual(Object.values(randomFirst).sort((a, b) => a - b), [0, 0.2, 0.4, 0.6]);
  const randomSecond = await random();
  assert.deepEqual(randomSecond, randomFirst, "the same seed repeats the same order through the service");
  const randomFrame = await frame(project, scene, 0.15);
  const firstRandomId = Object.keys(randomFirst).find((id) => randomFirst[id] === 0);
  const firstRandomLayer = firstRandomId.replace("fade-", "");
  const randomIndex = layers.indexOf(firstRandomLayer);
  colorAt(randomFrame, 15 + randomIndex * 30, 20, WHITE, "the random first slot is hidden in the rendered frame");
});

test("scene add, update, duplicate and delete change the saved document and its rendered frame", async () => {
  const project = "reach-scene-ops";
  const initial = await createProject(project, { width: 80, height: 40 });
  await edit(project, [
    { op: "add_scene", properties: { id: "outro", name: "Outro", width: 80, height: 40, duration: 2, background: "#ffffff" } },
    { op: "add_layer", scene: "outro", layerType: "rectangle", properties: {
      id: "mark", name: "Mark", x: 8, y: 8, width: 24, height: 20, fill: "#ff0000",
    } },
  ]);
  colorAt(await frame(project, "outro"), 12, 12, RED, "the added scene's layer is rendered");

  await edit(project, [{ op: "update_scene", scene: "outro", properties: { name: "Final", background: "#123456" } }]);
  const updatedRecord = await saved(project);
  assert.equal(sceneOf(updatedRecord, "outro").name, "Final");
  colorAt(await frame(project, "outro"), 50, 30, [18, 52, 86, 255], "update_scene changes the canvas paint");

  await edit(project, [{ op: "duplicate_scene", scene: "outro" }]);
  const duplicatedRecord = await saved(project);
  const copy = duplicatedRecord.document.scenes.find((item) => item.id !== initial && item.id !== "outro");
  assert.ok(copy, "duplicate_scene adds a new scene with a fresh ID");
  const originalFrame = await frame(project, "outro");
  const copiedFrame = await frame(project, copy.id);
  compareSamples(originalFrame, copiedFrame, [[12, 12], [50, 30]], "the duplicated scene renders its copied content and paint");

  await edit(project, [{ op: "delete_scene", scene: copy.id }]);
  assert.equal((await saved(project)).document.scenes.some((item) => item.id === copy.id), false, "delete_scene removes its target");
  await edit(project, [{ op: "delete_scene", scene: "outro" }]);
  assert.ok((await saved(project)).document.scenes.some((item) => item.id === initial), "the original project scene remains");
});

test("Bulk Create CSV re-import updates existing variants, preserves omitted ones by default, then deletes only by opt-in", async () => {
  const project = "reach-bulk-csv";
  const scene = await createProject(project, { width: 140, height: 60, background: "#111111" });
  await edit(project, [{ op: "add_layer", scene, layerType: "text", properties: {
    id: "title", name: "Title", text: "Base", x: 8, y: 12, width: 120, height: 36,
    fontSize: 24, fontFamily: "Inter", fontSource: "/api/fonts/Inter-400.ttf", fill: "#ffffff", textResize: "fixed",
  } }]);

  const firstCsv = "id,Title,info_log\r\none,Agent one,\r\ntwo,Agent two,\r\n";
  await edit(project, [{ op: "bulk_create", scene, csv: firstCsv }]);
  let record = await saved(project);
  assert.equal(sceneOf(record, scene).isComponent, true, "the source scene becomes a component");
  const variants = record.document.scenes.filter((item) => item.bulkVariant);
  assert.deepEqual(variants.map((item) => item.bulkVariant.key).sort(), ["one", "two"]);
  const one = variants.find((item) => item.bulkVariant.key === "one");
  const two = variants.find((item) => item.bulkVariant.key === "two");
  const oneBefore = await frame(project, one.id);
  const twoBefore = await frame(project, two.id);
  assert.ok(differentPixelCount(oneBefore, twoBefore) > 0, "the variant text creates distinct rendered pixels");

  await edit(project, [{ op: "bulk_create", scene, csv: "id,Title,info_log\r\none,Updated one,\r\n" }]);
  record = await saved(project);
  assert.ok(record.document.scenes.some((item) => item.id === two.id), "omitted variants stay by default");
  const oneUpdated = await frame(project, one.id);
  assert.ok(differentPixelCount(oneUpdated, oneBefore) > 0, "re-import updates the variant's actual rendered text");

  await edit(project, [{ op: "bulk_create", scene, csv: "id,Title,info_log\r\none,Updated one,\r\n", deleteMissing: true }]);
  record = await saved(project);
  assert.ok(!record.document.scenes.some((item) => item.id === two.id), "deleteMissing removes only omitted variants when requested");
  colorAt(await frame(project, one.id), 2, 2, [17, 17, 17, 255], "the retained variant still renders after deletion");
});

test("rich text ranges, local fonts and RTL content reach the saved-project renderer", async () => {
  const project = "reach-rich-text";
  const scene = await createProject(project, { width: 180, height: 64 });
  const fontBytes = await readFile(new URL("../tests/fonts/noto-sans-arabic-400-normal.ttf", import.meta.url));
  const upload = await server.api(`/api/media?project=${project}`, {
    method: "POST",
    headers: { "Content-Type": "font/ttf", "X-File-Name": "Noto Sans Arabic.ttf" },
    body: fontBytes,
  });
  assert.equal(upload.status, 201, "the local Arabic font fixture is uploaded to the test project");
  const arabic = await upload.json();

  await edit(project, [{ op: "add_layer", scene, layerType: "text", properties: {
    id: "rich", name: "Rich text", text: "Hi مرحبا 😊", x: 8, y: 12, width: 164, height: 40,
    textResize: "fixed", fontFamily: "Inter", fontSource: "/api/fonts/Inter-400.ttf", fontSize: 24, fill: "#111111",
  } }]);
  await edit(project, [
    { op: "style_text_range", scene, layer: "rich", text: "Hi", style: { fill: "#0000ff", fontWeight: 700 } },
    { op: "style_text_range", scene, layer: "rich", text: "مرحبا", style: {
      fill: "#ff0000", fontFamily: "Noto Sans Arabic", fontSource: arabic.src,
    } },
  ]);
  const stored = layerOf(sceneOf(await saved(project), scene), "rich");
  assert.equal(stored.text, "Hi مرحبا 😊", "the original mixed-direction text and emoji are preserved");
  assert.equal(stored.textStyleRanges.length, 2, "the agent stored two independent rich-text ranges");
  assert.equal(stored.textStyleRanges[1].style.fontSource, arabic.src, "the range points at its locally uploaded face");

  const rendered = await frame(project, scene);
  let bluePixels = 0, redPixels = 0, darkPixels = 0;
  for (let y = 0; y < rendered.height; y += 1) for (let x = 0; x < rendered.width; x += 1) {
    const [red, green, blue, alpha] = rendered.pixel(x, y);
    if (alpha === 255 && blue > red + 60 && blue > green + 60) bluePixels += 1;
    if (alpha === 255 && red > green + 60 && red > blue + 60) redPixels += 1;
    if (alpha === 255 && red < 80 && green < 80 && blue < 80) darkPixels += 1;
  }
  assert.ok(bluePixels > 5, `the Latin color range appears in the PNG (${bluePixels} blue pixels)`);
  assert.ok(redPixels > 5, `the Arabic color range appears in the PNG (${redPixels} red pixels)`);
  assert.ok(darkPixels > 5, `the unstyled text and emoji slot are rendered (${darkPixels} dark pixels)`);
});

test("variable font axes animate through edit, refuse values past the font's range and render heavier", async () => {
  const project = "reach-axes";
  const scene = await createProject(project, { width: 200, height: 64 });
  const upload = await server.api(`/api/media?project=${project}`, {
    method: "POST", headers: { "Content-Type": "font/ttf", "X-File-Name": "Roboto Flex.ttf" },
    body: await readFile(new URL("../tests/fonts/roboto-flex-axes-subset.ttf", import.meta.url)),
  });
  assert.equal(upload.status, 201, "the variable font fixture is uploaded");
  const flex = await upload.json();
  await edit(project, [
    { op: "add_layer", scene, layerType: "text", properties: { id: "word", name: "word", text: "kino", x: 8, y: 4, width: 184, height: 56,
      textResize: "fixed", fontFamily: "Roboto Flex", fontSource: flex.src, fontSize: 44, fill: "#111111", axes: { wght: 100 } } },
    { op: "add_animation", layer: "word", animation: { kind: "custom", name: "Weight", start: 0, duration: 1, easing: "linear",
      from: { axes: { wght: 100 } }, to: { axes: { wght: 1000 } } } },
  ]);
  const refused = await agent("edit", { project, ops: [{ op: "update_layer", layer: "word", properties: { axes: { wdth: 200 } } }] });
  assert.equal(refused.isError, true, `a width past the font range is refused: ${refused.text}`);
  assert.match(refused.text, /wdth 200 is outside Roboto Flex's range 25 to 151/);
  const ink = (image) => {
    let count = 0;
    for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) if (image.pixel(x, y)[0] < 128) count += 1;
    return count;
  };
  const thin = ink(await frame(project, scene, 0)), heavy = ink(await frame(project, scene, 1));
  assert.ok(heavy > thin * 1.8, `the sweep ends much heavier (${thin} to ${heavy} dark pixels)`);
  const check = await agent("check", { project });
  assert.doesNotMatch(check.text, /font_fallback/, "the variable face loaded, so check finds no fallback");
  // update_layer merges axes per axis, status shows them, and a static font names the way out.
  await edit(project, [{ op: "update_layer", layer: "word", properties: { axes: { wdth: 80 } } }]);
  assert.deepEqual(layerOf(sceneOf(await saved(project), scene), "word").axes, { wght: 100, wdth: 80 });
  assert.match((await agent("status", { project })).text, /Roboto Flex 100 wdth=80/);
  const stuck = await agent("edit", { project, ops: [{ op: "update_layer", layer: "word", properties: { fontFamily: "Inter", fontSource: "", axes: { wdth: 90 } } }] });
  assert.match(stuck.text, /Inter has no wght axis.*send axes:\{wght:null\} \(or axes:null for all\)/);
});

test("outline_text turns each letter into a path layer in a group that keeps the text's place and animations", async () => {
  const project = "reach-outline";
  const scene = await createProject(project, { width: 200, height: 64 });
  await edit(project, [{ op: "add_layer", scene, layerType: "text", properties: { id: "word", name: "word", text: "ki no", x: 8, y: 4,
    width: 184, height: 56, textResize: "fixed", fontSize: 44, fill: "#111111" } }]);
  await edit(project, [{ op: "add_animation", layer: "word", preset: "preset-fade", start: 0, duration: 0.5 }]);
  const ink = (image) => {
    let count = 0;
    for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) if (image.pixel(x, y)[0] < 128) count += 1;
    return count;
  };
  const before = ink(await frame(project, scene, 1));
  await edit(project, [{ op: "outline_text", layer: "word" }]);
  const layers = sceneOf(await saved(project), scene).layers;
  const group = layers.find((layer) => layer.name === "word outlines");
  const letters = layers.filter((layer) => layer.parentId === group.id);
  assert.deepEqual(letters.map((layer) => [layer.type, layer.name]), [["path", "k"], ["path", "i"], ["path", "n"], ["path", "o"]], "one path per letter, the space has none");
  assert.equal(layerOf({ id: scene, layers }, "word").visible, false, "the text stays, hidden");
  assert.deepEqual([group.x, group.y, group.width, group.height, group.animations.length], [8, 4, 184, 56, 1], "the group takes the text's place and its fade");
  const after = ink(await frame(project, scene, 1));
  assert.ok(Math.abs(after - before) <= before * 0.05, `the outlines draw the same letters (${before} vs ${after} dark pixels)`);
});

test("dry-run, atomic refusal, idempotency, stale revisions and history recovery keep saved pixels authoritative", async () => {
  const project = "reach-recovery";
  const scene = await createProject(project, { width: 80, height: 40 });
  const added = await edit(project, [{ op: "add_layer", scene, layerType: "rectangle", properties: {
    id: "card", name: "Card", x: 5, y: 5, width: 20, height: 20, fill: "#ff0000",
  } }]);
  const originalRevision = added.data.rev;

  const dryRun = await agent("edit", { project, rev: originalRevision, dry_run: true,
    ops: [{ op: "update_layer", scene, layer: "card", properties: { fill: "#0000ff" } }] });
  assert.equal(dryRun.isError, undefined, dryRun.text);
  assert.equal(dryRun.data.dryRun, true);
  assert.equal((await saved(project)).revision, originalRevision, "dry_run does not save a revision");
  colorAt(await frame(project, scene), 10, 10, RED, "dry_run leaves the saved red pixels alone");

  const once = [{ op: "update_layer", scene, layer: "card", properties: { x: 15 } }];
  const first = await edit(project, once, { rev: originalRevision, request_id: "move-card-once" });
  const repeated = await edit(project, once, { rev: originalRevision, request_id: "move-card-once" });
  assert.equal(repeated.data.repeated, true, "the same request ID returns the saved result");
  assert.equal(repeated.data.rev, first.data.rev);
  assert.equal((await saved(project)).revision, originalRevision + 1, "idempotent replay adds no revision");

  const rebased = await edit(project, [{ op: "update_layer", scene, layer: "card", properties: { y: 12 } }], { rev: originalRevision });
  assert.equal(rebased.data.rebased, true, "an ID-addressed edit with a live target rebases");
  const beforeRefusal = await saved(project);
  const refused = await agent("edit", { project, rev: beforeRefusal.revision, ops: [
    { op: "update_layer", scene, layer: "card", properties: { x: 40 } },
    { op: "update_layer", scene, layer: "missing-card", properties: { x: 1 } },
  ] });
  assert.equal(refused.isError, true, "one invalid operation refuses the whole batch");
  assert.equal((await saved(project)).revision, beforeRefusal.revision, "the refused batch writes no revision");
  assert.equal(layerOf(sceneOf(await saved(project), scene), "card").x, 15, "the valid first operation was rolled back with the batch");

  await agent("notes", { project, action: "add", text: "Checkpoint before deleting the card", by: "you" });
  const removed = await edit(project, [{ op: "delete_layer", scene, layer: "card" }], { rev: beforeRefusal.revision });
  const conflict = await agent("edit", { project, rev: beforeRefusal.revision,
    ops: [{ op: "update_layer", scene, layer: "card", properties: { y: 25 } }] });
  assert.equal(conflict.isError, true);
  assert.equal(conflict.data.error, "conflict", "an edit against a deleted stale target returns a conflict");
  assert.equal(conflict.data.currentRev, removed.data.rev);
  assert.equal((await saved(project)).revision, removed.data.rev, "the conflict writes no revision");

  const restored = await agent("history", { project, action: "revert", turn: removed.data.turn });
  assert.equal(restored.isError, undefined, restored.text);
  assert.equal(restored.data.reverted, removed.data.turn, "history reverted the deletion's edit turn");
  assert.ok(layerOf(sceneOf(await saved(project), scene), "card"), "history revert restores the deleted layer");
  colorAt(await frame(project, scene), 20, 18, RED, "the restored layer has the saved red render");
});
