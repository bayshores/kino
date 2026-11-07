import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import { evaluateLayer } from "../engine/animation.js";
import { duplicateSelection } from "../engine/duplicate.js";
import { applyFromStart, nudgeSelection, selectionBox, transformTargets } from "../engine/multiTransform.js";
import { selectionTransformFromFields } from "../engine/selectionTransformFields.js";
import { importSvg } from "../engine/svgImport.js";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { expandComponents } from "../engine/linkedComponents.js";
import { exportScene } from "./export.mjs";
import { readImage, startTestServer } from "./media.test.support.mjs";
// These tests are about reaching features; approvals (D3) are tested in dashboard tests and
// in agent-reach-workspace's approval test, so the person here allows them.
const REACH_ALLOW = ["delete-scene", "delete-project", "share-link", "final-render", "overwrite-export", "large-import"];

let server;
before(async () => { server = await startTestServer({ allow: REACH_ALLOW }); });
after(() => server?.stop());

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

async function createProject(id, document) {
  const response = await server.api("/api/projects", { method: "POST", body: { document } });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).document.id, id);
}

async function saved(id) {
  const response = await server.api(`/api/projects/${id}`);
  assert.equal(response.status, 200);
  return response.json();
}

function fixture(id, layers = [
  createLayer("rectangle", { id: "red", name: "Red", x: 24, y: 30, width: 48, height: 36, fill: "#ff0000", strokeWidth: 0, radius: 0 }),
  createLayer("rectangle", { id: "blue", name: "Blue", x: 168, y: 72, width: 40, height: 32, fill: "#0000ff", strokeWidth: 0, radius: 0 }),
  createLayer("rectangle", { id: "locked", name: "Locked", x: 248, y: 34, width: 28, height: 28, fill: "#ffff00", strokeWidth: 0, radius: 0, locked: true }),
]) {
  return parseDocument(createDocument({ id, name: id, scenes: [createScene({
    id: "main", name: "Main", width: 320, height: 240, duration: 1, background: "#101114", layers,
  })] }));
}

function expectedMove(document, layerIds, dx, dy) {
  const scene = document.scenes[0];
  const changes = nudgeSelection(scene.layers, layerIds, dx, dy);
  const patches = new Map(changes.map((change) => [change.id, change]));
  return parseDocument({ ...document, scenes: document.scenes.map((item) => item.id === scene.id
    ? { ...item, layers: item.layers.map((layer) => patches.has(layer.id) ? { ...layer, ...patches.get(layer.id) } : layer) }
    : item) });
}

function expectedSelectionTransform(document, layerIds, action) {
  const scene = document.scenes[0];
  const box = selectionBox(transformTargets(scene.layers, layerIds), scene.layers, { scenes: document.scenes });
  const layers = applyFromStart(scene.layers, scene.layers, layerIds, selectionTransformFromFields(scene.layers, layerIds, box, action).changes);
  return parseDocument({ ...document, scenes: document.scenes.map((item) => item === scene ? { ...scene, layers } : item) });
}

async function assertAgentFrameMatchesManualRender(project, expectedDocument) {
  const frame = await agent("look", { project, scene: "main", mode: "frame", t: 0, width: 320 });
  assert.equal(frame.isError, undefined, frame.text);
  assert.equal(frame.images?.[0]?.mime, "image/png");
  const actual = await readImage(Buffer.from(frame.images[0].data, "base64"));
  const rendered = await exportScene(expandComponents(expectedDocument, "main"), { format: "png", time: 0, width: 320 });
  const expected = await readImage(rendered.buffer);
  assert.deepEqual([actual.width, actual.height], [expected.width, expected.height]);
  for (let y = 0; y < actual.height; y += 1) {
    for (let x = 0; x < actual.width; x += 1) {
      assert.deepEqual(actual.pixel(x, y), expected.pixel(x, y), `look pixel (${x}, ${y}) matches the manual helper render`);
    }
  }
}

test("duplicate and multi-transform edits follow the manual helpers and render through agent look", async () => {
  const before = fixture("geometry-edit");
  await createProject(before.id, before);

  const ops = [
    { op: "duplicate_layers", scene: "main", layers: ["red"], offset: 24 },
    { op: "multi_transform", scene: "main", layers: ["red", "blue"], action: { kind: "move", dx: 12, dy: -6 } },
    { op: "multi_transform", scene: "main", layers: ["red", "blue"], action: { kind: "scale", scaleX: 115, scaleY: 90, anchor: "bottom-right" } },
    { op: "multi_transform", scene: "main", layers: ["red", "blue"], action: { kind: "rotate", degrees: 13 } },
  ];

  let expected = duplicateSelection(before, "main", ["red"], 24).document;
  expected = expectedMove(expected, ["red", "blue"], 12, -6);
  expected = expectedSelectionTransform(expected, ["red", "blue"], { kind: "scale", scaleX: 115, scaleY: 90, anchor: "bottom-right" });
  expected = expectedSelectionTransform(expected, ["red", "blue"], { kind: "rotate", degrees: 13 });

  const reply = await agent("edit", { project: before.id, ops });
  assert.equal(reply.isError, undefined, reply.text);
  const record = await saved(before.id);
  assert.equal(record.revision, 2);
  // Fresh layer IDs are intentionally random on both the service and manual helper paths.
  const expectedScene = expected.scenes[0];
  const actualCopy = record.document.scenes[0].layers.find((layer) => layer.name === "Red copy");
  expected = parseDocument({ ...expected, scenes: [{ ...expectedScene, layers: expectedScene.layers.map((layer) =>
    layer.name === "Red copy" ? { ...layer, id: actualCopy.id } : layer) }] });
  assert.deepEqual(record.document, expected);
  assert.equal(record.document.scenes[0].layers.filter((layer) => layer.name === "Red copy").length, 1);
  await assertAgentFrameMatchesManualRender(before.id, expected);
});

test("server SVG import applies finite offsets, returns fidelity warnings, and renders the imported artwork", async () => {
  const before = fixture("geometry-svg", []);
  await createProject(before.id, before);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">
    <path id="green-mark" d="M 20 20 h 48 v 36 h -48 Z" fill="#00cc66" fill-rule="unsupported" />
  </svg>`;
  const imported = importSvg(svg, { name: "Green mark", DOMParser });
  const moved = imported.layers.map((layer) => layer.parentId ? layer : { ...layer, x: layer.x + 36, y: layer.y + 14 });
  const scene = before.scenes[0];
  let expected = parseDocument({ ...before, scenes: [{ ...scene, layers: [...scene.layers, ...moved] }] });

  const reply = await agent("edit", { project: before.id, ops: [
    { op: "import_svg", scene: "main", svg, name: "Green mark", x: 36, y: 14 },
  ] });
  assert.equal(reply.isError, undefined, reply.text);
  assert.ok(reply.data.warnings?.some((warning) => /fill-rule values other than/.test(warning)), "the importer warning reaches the agent receipt");
  const record = await saved(before.id);
  const importedLayer = record.document.scenes[0].layers.at(-1);
  expected = parseDocument({ ...expected, scenes: [{ ...expected.scenes[0], layers: expected.scenes[0].layers.map((layer) =>
    layer.name === imported.layers[0].name ? { ...layer, id: importedLayer.id } : layer) }] });
  assert.deepEqual(record.document, expected);
  assert.equal(record.document.scenes[0].layers[0].x, 56);
  await assertAgentFrameMatchesManualRender(before.id, expected);
});

test("multi-transform coalesces a selected group and child and refuses unresolved selected IDs", async () => {
  const before = fixture("geometry-group", [
    createLayer("group", { id: "group", name: "Group", x: 28, y: 112, width: 100, height: 76 }),
    createLayer("rectangle", { id: "child", name: "Child", parentId: "group", x: 8, y: 12, width: 44, height: 30, fill: "#00cc66", strokeWidth: 0, radius: 0 }),
    createLayer("rectangle", { id: "other", name: "Other", x: 212, y: 136, width: 32, height: 28, fill: "#ff00ff", strokeWidth: 0, radius: 0 }),
  ]);
  await createProject(before.id, before);

  const unresolved = await agent("edit", { project: before.id, ops: [
    { op: "multi_transform", scene: "main", layers: ["group", "missing"], action: { kind: "move", dx: 10, dy: 0 } },
  ] });
  assert.equal(unresolved.isError, true);
  assert.equal((await saved(before.id)).revision, 1, "an unresolved selection saves nothing");

  const expected = expectedMove(before, ["group", "child"], 16, 9);
  const reply = await agent("edit", { project: before.id, ops: [
    { op: "multi_transform", scene: "main", layers: ["group", "child"], action: { kind: "move", dx: 16, dy: 9 } },
  ] });
  assert.equal(reply.isError, undefined, reply.text);
  const record = await saved(before.id);
  assert.deepEqual(record.document, expected);
  assert.equal(record.document.scenes[0].layers.find((layer) => layer.id === "group").x, 44);
  assert.equal(record.document.scenes[0].layers.find((layer) => layer.id === "child").x, 8, "the child is not moved a second time");
  await assertAgentFrameMatchesManualRender(before.id, expected);
});

test("geometry edits preserve dry-run, refusal atomicity, retry, and request idempotency boundaries", async () => {
  const before = fixture("geometry-boundaries");
  await createProject(before.id, before);

  const duplicate = { op: "duplicate_layers", scene: "main", layers: ["red"] };
  const dryRun = await agent("edit", { project: before.id, dry_run: true, ops: [duplicate] });
  assert.equal(dryRun.data.dryRun, true);
  assert.equal((await saved(before.id)).revision, 1, "dry-run performs no save");

  const once = await agent("edit", { project: before.id, request_id: "geometry-duplicate-once", ops: [duplicate] });
  const repeated = await agent("edit", { project: before.id, request_id: "geometry-duplicate-once", ops: [duplicate] });
  assert.equal(once.data.rev, 2);
  assert.equal(repeated.data.repeated, true, "the same request ID returns its earlier receipt");
  assert.equal((await saved(before.id)).document.scenes[0].layers.filter((layer) => layer.name === "Red copy").length, 1);

  const refused = await agent("edit", { project: before.id, ops: [
    { op: "multi_transform", scene: "main", layers: ["red"], action: { kind: "move", dx: 20, dy: 0 } },
    { op: "multi_transform", scene: "main", layers: ["locked"], action: { kind: "move", dx: 5, dy: 0 } },
  ] });
  assert.equal(refused.isError, true);
  assert.match(refused.data.reason, /locked/i);
  assert.equal(refused.data.safeToRetry, true);
  assert.equal((await saved(before.id)).revision, 2, "the valid first operation is rolled back with the refusal");

  const retry = await agent("edit", { project: before.id, retry: refused.data.retry, fix: {
    "1": { layers: ["blue"] },
  } });
  assert.equal(retry.isError, undefined, retry.text);
  assert.equal(retry.data.rev, 3);
  const after = (await saved(before.id)).document;
  assert.equal(after.scenes[0].layers.find((layer) => layer.id === "red").x, 44);
  assert.equal(after.scenes[0].layers.find((layer) => layer.id === "blue").x, 173);
});

// An animation's x and y are places in the scene. Before, multi_transform moved only the
// layer, so a slide still ended at the old place and the layer jumped back there once it
// played; scale and rotate left the animations behind the same way.
test("multi_transform takes a layer's animations along: a slide ends where the layer now is, and a scale or a turn carries them too", async () => {
  const before = fixture("carry", []);
  await createProject(before.id, before);
  const setup = await agent("edit", { project: before.id, ops: [
    { op: "update_scene", scene: "main", properties: { duration: 4 } },
    { op: "add_layer", scene: "main", layerType: "rectangle", name: "card",
      properties: { x: 40, y: 60, width: 60, height: 40, fill: "#ffffff", strokeWidth: 0, radius: 0 },
      animations: [
        { preset: "preset-slide", start: 0, duration: 0.5, parameters: { direction: "up", distance: 20 } },
        { kind: "custom", name: "Drift", start: 2, duration: 0.5, to: { x: 100 } },
      ] },
  ] });
  assert.equal(setup.isError, undefined, setup.text);

  const moved = await agent("edit", { project: before.id, ops: [
    { op: "multi_transform", scene: "main", layers: ["card"], action: { kind: "move", dx: 100, dy: 80 } },
  ] });
  assert.equal(moved.isError, undefined, moved.text);
  assert.equal(moved.data.warnings, undefined, "nothing is left behind, so nothing is warned");
  const isWhite = (image, x, y) => image.pixel(x, y).slice(0, 3).every((value) => value > 240);
  const frameAt = async (t) => {
    const frame = await agent("look", { project: before.id, scene: "main", mode: "frame", t, width: 320 });
    assert.equal(frame.isError, undefined, frame.text);
    return readImage(Buffer.from(frame.images[0].data, "base64"));
  };
  const settled = await frameAt(1);
  assert.equal(isWhite(settled, 170, 160), true, "after the slide the card rests at its new place (140, 140)");
  assert.equal(isWhite(settled, 70, 80), false, "not back at its old place");
  const drifted = await frameAt(3);
  assert.equal(isWhite(drifted, 230, 160), true, "the drift still ends 60 px right of the card's place");
  assert.equal(isWhite(drifted, 150, 160), false);

  const card = async () => (await saved(before.id)).document.scenes[0].layers.find((layer) => layer.id === "card");
  const slideOf = (layer) => layer.animations.find((animation) => animation.kind === "in");
  const was = await card();
  const slideLength = slideOf(was).from.y - slideOf(was).to.y;
  assert.ok(slideLength > 0);

  const scaled = await agent("edit", { project: before.id, ops: [
    { op: "multi_transform", scene: "main", layers: ["card"], action: { kind: "scale", scaleX: 150, scaleY: 150 } },
  ] });
  assert.equal(scaled.isError, undefined, scaled.text);
  let layer = await card();
  assert.deepEqual([layer.x, layer.y, layer.width, layer.height], [125, 130, 90, 60]);
  assert.deepEqual(evaluateLayer(layer, 1).y, layer.y, "the slide ends where the scaled card is");
  assert.equal(evaluateLayer(layer, 0).y - layer.y, slideLength * 1.5, "and slides 1.5 times as far");
  assert.equal(evaluateLayer(layer, 3).x - layer.x, 90, "the drift grows with the card: 60 px becomes 90");

  const turned = await agent("edit", { project: before.id, ops: [
    { op: "multi_transform", scene: "main", layers: ["card"], action: { kind: "rotate", degrees: 90 } },
  ] });
  assert.equal(turned.isError, undefined, turned.text);
  layer = await card();
  assert.deepEqual([layer.x, layer.y, layer.rotation], [125, 130, 90]);
  const start = evaluateLayer(layer, 0), rest = evaluateLayer(layer, 1), end = evaluateLayer(layer, 3);
  assert.deepEqual([start.x, start.y], [125 - slideLength * 1.5, 130], "a slide up, turned a quarter, comes in from the left");
  assert.deepEqual([rest.x, rest.y], [125, 130]);
  assert.deepEqual([end.x, end.y], [125, 220], "the drift right now goes down");
});

test("behaviors and counted duplicates reach the agent: a looping, wiggling dot copied in a row passes check, draws in look and bakes into Lottie", async () => {
  const before = fixture("geometry-behaviors", [
    createLayer("rectangle", { id: "dot", name: "Dot", x: 30, y: 100, width: 24, height: 24, fill: "#ff0000", strokeWidth: 0, radius: 0 }),
  ]);
  await createProject(before.id, { ...before, scenes: [{ ...before.scenes[0], duration: 7 }] });
  const reply = await agent("edit", { project: before.id, ops: [
    { op: "add_animation", layer: "dot", animation: { kind: "custom", name: "Spin", start: 0, duration: 0.5, easing: "linear",
      from: { rotation: 0 }, to: { rotation: 90 }, behavior: { loop: { mode: "cycle" } } } },
    { op: "add_animation", layer: "dot", animation: { kind: "custom", name: "Drift", start: 0, duration: 2, from: {}, to: {},
      behavior: { wiggle: { amount: { y: 8 }, rate: 3, seed: 5 } } } },
    { op: "duplicate_layers", layers: ["dot"], count: 3, layout: "line", spacing: { x: 60, y: 0 }, stagger: 0.1 },
  ] });
  assert.equal(reply.isError, undefined, reply.text);
  const layers = (await saved(before.id)).document.scenes[0].layers;
  const named = (name) => layers.find((layer) => layer.name === name);
  assert.deepEqual(["Dot", "Dot 2", "Dot 3", "Dot 4"].map((name) => [named(name).x, named(name).animations[0].start]),
    [[30, 0], [90, 0.1], [150, 0.2], [210, 0.3]], "real copies 60 px apart, each 0.1 s later");
  assert.deepEqual(named("Dot 4").animations[1].behavior, { wiggle: { amount: { y: 8 }, rate: 3, seed: 5 } });

  // The linear spin loops, so it counts as perpetual (no linear_motion), and it keeps turning
  // after the wiggle ends at 2.3 s, so the scene is not static either.
  const check = await agent("check", { project: before.id, pixels: false });
  assert.deepEqual(check.data.findings.filter((finding) => ["linear_motion", "static_scene"].includes(finding.rule)), []);
  const frame = await agent("look", { project: before.id, scene: "main", mode: "frame", t: 1.2, width: 320 });
  assert.equal(frame.isError, undefined, frame.text);
  const image = await readImage(Buffer.from(frame.images[0].data, "base64"));
  const dot = evaluateLayer(named("Dot"), 1.2);
  assert.deepEqual(image.pixel(Math.round(dot.x + 12), Math.round(dot.y + 12)).slice(0, 3), [255, 0, 0], "the dot draws where the wiggle puts it");

  // Lottie bakes the loop and the wiggle into one keyframe per frame, equal to evaluateLayer.
  const fps = 10;
  const lottie = JSON.parse((await exportScene(expandComponents((await saved(before.id)).document, "main"), { format: "lottie", fps })).buffer.toString("utf8"));
  const baked = lottie.layers.find((layer) => layer.nm === "Dot");
  for (const keyframe of baked.ks.r.k) {
    const expected = evaluateLayer(named("Dot"), keyframe.t / fps).rotation;
    assert.ok(Math.abs(keyframe.s[0] - expected) < 1e-3, `frame ${keyframe.t}: rotation ${keyframe.s[0]}, expected ${expected}`);
  }
  assert.ok(baked.ks.r.k.some((keyframe) => keyframe.t > 5 && keyframe.s[0] > 1), "the spin keeps turning after its first pass");
  const at = (t) => baked.ks.r.k.find((keyframe) => keyframe.t === t);
  assert.deepEqual([at(4).h, at(9).h, at(3).h], [1, 1, undefined], "each new pass jumps back (hold) instead of turning back");
  const ys = baked.ks.p.k.map((keyframe) => keyframe.s[1]);
  assert.ok(Math.max(...ys) - Math.min(...ys) > 1, "the wiggle moves the baked position");
});

test("a text range selector reaches the agent: one add_animation types the letters in, and a wave on an in is refused", async () => {
  const before = fixture("geometry-range", [createLayer("text", { id: "word", name: "Word", text: "TYPE", x: 20, y: 80, width: 280, height: 80,
    fontFamily: "Inter", fontSize: 60, fill: "#ffffff" })]);
  await createProject(before.id, before);
  const typed = await agent("edit", { project: before.id, ops: [
    { op: "add_animation", layer: "word", preset: "preset-fade", start: 0, duration: 1, unit: "letters", range: "typewriter" }] });
  assert.equal(typed.isError, undefined, typed.text);
  assert.deepEqual((await saved(before.id)).document.scenes[0].layers[0].animations.at(-1).range,
    { shape: "square", start: 0, end: [0, 1], smoothness: 1, preset: "typewriter" });
  const wave = await agent("edit", { project: before.id, ops: [
    { op: "add_animation", layer: "word", preset: "preset-fade", start: 0, duration: 1, unit: "letters", range: "wave" }] });
  assert.match(wave.text, /custom animation/);
});

test("later ops of the same edit can name what duplicate_layers and split_layer make", async () => {
  const before = fixture("geometry-copies", [
    createLayer("rectangle", { id: "card", name: "card", x: 30, y: 100, width: 24, height: 24, fill: "#ff0000", strokeWidth: 0, radius: 0 }),
    createLayer("video", { id: "app", name: "app", src: "/api/media/app.mp4", width: 160, height: 90, mediaDuration: 4, mediaSourceDuration: 6, mediaFreeze: "none" }),
    createLayer("video", { id: "shot", name: "shot 1", src: "/api/media/app.mp4", width: 160, height: 90, mediaDuration: 4, mediaSourceDuration: 6, mediaFreeze: "none" }),
  ]);
  await createProject(before.id, { ...before, scenes: [{ ...before.scenes[0], duration: 4 }] });
  const reply = await agent("edit", { project: before.id, ops: [
    { op: "duplicate_layers", layers: ["card"] },
    { op: "update_layer", layer: "card copy", properties: { fill: "#00ff00" } },
    { op: "duplicate_layers", layers: ["card"], count: 2 },
    { op: "update_layer", layer: "card 3", properties: { fill: "#0000ff" } },
    { op: "split_layer", layer: "app", from: 1, to: 1.5 },
    { op: "split_layer", layer: "app 2", at: 2 },
    { op: "update_layer", layer: "app 3", properties: { volume: 0.5 } },
    { op: "split_layer", layer: "shot 1", at: 2 },
  ] });
  assert.equal(reply.isError, undefined, reply.text);
  const layers = (await saved(before.id)).document.scenes[0].layers;
  const named = (name) => layers.find((layer) => layer.name === name);
  assert.deepEqual([named("card copy").id, named("card copy").fill, named("card 3").fill], ["card-copy", "#00ff00", "#0000ff"]);
  assert.deepEqual(["app", "app 2", "app 3"].map((name) => [named(name).mediaStart, named(name).mediaOffset, named(name).mediaDuration]),
    [[0, 0, 1], [1, 1.5, 1], [2, 2.5, 1.5]], "a 0.5 s skip at 1 s, then a cut at 2 s");
  assert.equal(named("app 3").volume, 0.5);
  assert.equal(named("shot 1 2")?.mediaStart, 2, "a numbered name that is not a piece keeps its number");
});
