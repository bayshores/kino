import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { mergeDocuments } from "./documentMerge.js";

const parsed = (scenes, id = "merge-file") => parseDocument(createDocument({ id, name: "Merge file", scenes }));
const oneScene = (layers, extra = {}) => createScene({ id: "scene", name: "Scene", duration: 12, layers, ...extra });
const findLayer = (document, id) => document.scenes.flatMap((scene) => scene.layers).find((layer) => layer.id === id);
const animation = (id, start, from = { x: 0 }, to = { x: 100 }) => ({
  id, name: id, kind: "custom", start, duration: 1, easing: "linear", from, to,
  unit: "layer", stagger: 0, order: "forward",
});
const conflictAt = (conflicts, path) => conflicts.find((item) => JSON.stringify(item.path) === JSON.stringify(path));

test("merges independent edits on different layers and different properties", () => {
  const base = parsed([oneScene([
    createLayer("rectangle", { id: "alpha", x: 10, y: 20 }),
    createLayer("rectangle", { id: "beta", fill: "#112233" }),
  ])]);
  const ours = structuredClone(base);
  const theirs = structuredClone(base);
  findLayer(ours, "alpha").x = 44;
  findLayer(theirs, "alpha").y = 55;
  findLayer(theirs, "beta").fill = "#abcdef";

  const result = mergeDocuments(base, ours, theirs);
  assert.equal(findLayer(result.document, "alpha").x, 44);
  assert.equal(findLayer(result.document, "alpha").y, 55);
  assert.equal(findLayer(result.document, "beta").fill, "#abcdef");
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(parseDocument(result.document), result.document);
});

test("same-property edits report a conflict and keep the later local value", () => {
  const base = parsed([oneScene([createLayer("rectangle", { id: "box", x: 10 })])]);
  const ours = structuredClone(base), theirs = structuredClone(base);
  findLayer(ours, "box").x = 20;
  findLayer(theirs, "box").x = 30;

  const result = mergeDocuments(base, ours, theirs);
  assert.equal(findLayer(result.document, "box").x, 20);
  assert.deepEqual(conflictAt(result.conflicts, ["scenes", "scene", "layers", "box", "x"]), {
    path: ["scenes", "scene", "layers", "box", "x"], ours: 20, theirs: 30, resolution: "ours",
  });
});

test("deleting a layer wins over a concurrent edit", () => {
  const base = parsed([oneScene([createLayer("rectangle", { id: "box", x: 10 })])]);
  const ours = structuredClone(base), theirs = structuredClone(base);
  ours.scenes[0].layers = [];
  findLayer(theirs, "box").x = 80;

  const result = mergeDocuments(base, ours, theirs);
  assert.equal(findLayer(result.document, "box"), undefined);
  const conflict = result.conflicts.find((item) => item.resolution === "deleted");
  assert.ok(conflict);
  assert.deepEqual(conflict.path, ["scenes", "scene", "layers", "box"]);
  assert.equal(conflict.oursDeleted, true);
  assert.equal(conflict.theirsDeleted, undefined);
  assert.deepEqual(parseDocument(result.document), result.document);
});

test("combines concurrent insertions and a one-sided reorder with property edits", () => {
  const base = parsed([oneScene(["a", "b", "c"].map((id, index) => createLayer("rectangle", { id, x: index })))]);
  const ours = structuredClone(base), theirs = structuredClone(base);
  ours.scenes[0].layers = [ours.scenes[0].layers[1], ours.scenes[0].layers[0], ours.scenes[0].layers[2], createLayer("rectangle", { id: "local-new" })];
  theirs.scenes[0].layers.push(createLayer("rectangle", { id: "remote-new" }));
  findLayer(ours, "a").x = 10;
  findLayer(theirs, "c").y = 30;

  const result = mergeDocuments(base, ours, theirs);
  const layers = result.document.scenes[0].layers;
  const ids = layers.map((layer) => layer.id);
  assert.equal(new Set(ids).size, 5);
  assert.deepEqual(new Set(ids), new Set(["a", "b", "c", "local-new", "remote-new"]));
  assert.ok(ids.indexOf("b") < ids.indexOf("a"), "the uncontested local reorder remains in effect");
  assert.equal(findLayer(result.document, "a").x, 10);
  assert.equal(findLayer(result.document, "c").y, 30);
  assert.deepEqual(result.conflicts.filter((item) => item.kind === "order"), []);
  assert.deepEqual(parseDocument(result.document), result.document);
});

test("reparenting a layer preserves a remote edit to its other properties", () => {
  const base = parsed([oneScene([
    createLayer("group", { id: "group", width: 200, height: 100 }),
    createLayer("rectangle", { id: "child", x: 10, y: 20 }),
  ])]);
  const ours = structuredClone(base), theirs = structuredClone(base);
  findLayer(ours, "child").parentId = "group";
  findLayer(theirs, "child").x = 90;

  const result = mergeDocuments(base, ours, theirs);
  assert.equal(findLayer(result.document, "child").parentId, "group");
  assert.equal(findLayer(result.document, "child").x, 90);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(parseDocument(result.document), result.document);
});

test("moving an animation out of a Composed group keeps a concurrent member edit", () => {
  const group = { id: "group", name: "Group", kind: "composed", start: 1, animations: [
    animation("moving", 0), animation("staying", 1, { y: 0 }, { y: 20 }),
  ] };
  const base = parsed([oneScene([createLayer("rectangle", { id: "box", animations: [group] })])]);
  const ours = structuredClone(base), theirs = structuredClone(base);
  const localLayer = findLayer(ours, "box");
  const localGroup = localLayer.animations.find((item) => item.id === "group");
  const moving = localGroup.animations.shift();
  moving.start += localGroup.start;
  localLayer.animations.push(moving);
  const remoteMoving = findLayer(theirs, "box").animations[0].animations.find((item) => item.id === "moving");
  remoteMoving.to.x = 240;

  const result = mergeDocuments(base, ours, theirs);
  const output = findLayer(result.document, "box");
  const outputGroup = output.animations.find((item) => item.id === "group");
  const outputMoving = output.animations.find((item) => item.id === "moving");
  assert.equal(outputMoving.start, 1, "the move uses the scene clock after leaving its group");
  assert.equal(outputMoving.to.x, 240, "the separate remote property edit survives");
  assert.deepEqual(outputGroup.animations.map((item) => item.id), ["staying"]);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(parseDocument(result.document), result.document);
});

test("crossed Composed-group moves that create an unreachable cycle are refused", () => {
  const group = (id, memberId) => ({
    id, name: id, kind: "composed", start: 0,
    animations: [animation(memberId, 0)],
  });
  const base = parsed([oneScene([createLayer("rectangle", {
    id: "box", animations: [group("group-a", "a-member"), group("group-b", "b-member")],
  })])]);
  const ours = structuredClone(base), theirs = structuredClone(base);
  const oursRoot = findLayer(ours, "box").animations;
  const oursA = oursRoot.splice(oursRoot.findIndex((item) => item.id === "group-a"), 1)[0];
  oursRoot.find((item) => item.id === "group-b").animations.push(oursA);
  const theirsRoot = findLayer(theirs, "box").animations;
  const theirsB = theirsRoot.splice(theirsRoot.findIndex((item) => item.id === "group-b"), 1)[0];
  theirsRoot.find((item) => item.id === "group-a").animations.push(theirsB);
  assert.doesNotThrow(() => parseDocument(ours));
  assert.doesNotThrow(() => parseDocument(theirs));

  assert.throws(() => mergeDocuments(base, ours, theirs), /cycle/i);
});

test("scene background animations are merged by their stable IDs", () => {
  const base = parsed([oneScene([], {
    background: "#ffffff",
    backgroundAnimations: [animation("background-color", 0, { fill: "#ffffff" }, { fill: "#ff0000" })],
  })]);
  const ours = structuredClone(base), theirs = structuredClone(base);
  ours.scenes[0].backgroundEnabled = false;
  theirs.scenes[0].backgroundAnimations[0].to.fill = "#0000ff";

  const result = mergeDocuments(base, ours, theirs);
  assert.equal(result.document.scenes[0].backgroundEnabled, false);
  assert.equal(result.document.scenes[0].backgroundAnimations[0].to.fill, "#0000ff");
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(parseDocument(result.document), result.document);
});

test("paint gradients, shadows, and text style ranges resolve atomically", () => {
  const gradientA = { type: "linear", angle: 0, stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }] };
  const gradientB = { ...structuredClone(gradientA), stops: [{ offset: 0, color: "#00ff00" }, { offset: 1, color: "#0000ff" }] };
  const gradientC = { ...structuredClone(gradientA), angle: 90 };
  const shadowA = { color: "#00000080", x: 2, y: 3, blur: 4 };
  const shadowB = { ...shadowA, x: 10 };
  const shadowC = { ...shadowA, blur: 12 };
  const rangesA = [{ start: 0, end: 1, style: { fill: "#ff0000" } }];
  const rangesB = [{ start: 0, end: 1, style: { fill: "#00ff00" } }];
  const rangesC = [{ start: 0, end: 1, style: { fill: "#0000ff" } }];
  const base = parsed([oneScene([createLayer("text", {
    id: "title", text: "AB", fill: gradientA, shadow: shadowA, textStyleRanges: rangesA,
  })])]);
  const ours = structuredClone(base), theirs = structuredClone(base);
  Object.assign(findLayer(ours, "title"), { fill: gradientB, shadow: shadowB, textStyleRanges: rangesB });
  Object.assign(findLayer(theirs, "title"), { fill: gradientC, shadow: shadowC, textStyleRanges: rangesC });

  const result = mergeDocuments(base, ours, theirs);
  const output = findLayer(result.document, "title");
  assert.deepEqual(output.fill, gradientB);
  assert.deepEqual(output.shadow, shadowB);
  assert.deepEqual(output.textStyleRanges, rangesB);
  for (const property of ["fill", "shadow", "textStyleRanges"])
    assert.equal(conflictAt(result.conflicts, ["scenes", "scene", "layers", "title", property])?.resolution, "ours", `${property} is one atomic conflict`);
  assert.deepEqual(parseDocument(result.document), result.document);
});

test("component override maps merge independent properties at the same component path", () => {
  const source = createScene({ id: "component", isComponent: true, layers: [
    createLayer("rectangle", { id: "shape", x: 0, fill: "#111111" }),
  ] });
  const main = oneScene([createLayer("component", {
    id: "instance", componentSceneId: "component", componentOverrides: { shape: { x: 10, fill: "#222222" } },
  })]);
  const base = parsed([source, main]);
  const ours = structuredClone(base), theirs = structuredClone(base);
  findLayer(ours, "instance").componentOverrides.shape.x = 25;
  findLayer(theirs, "instance").componentOverrides.shape.fill = "#abcdef";

  const result = mergeDocuments(base, ours, theirs);
  const saved = parseDocument(result.document);
  assert.deepEqual(findLayer(saved, "instance").componentOverrides.shape, { x: 25, fill: "#abcdef" });
  assert.deepEqual(result.conflicts, []);
});

test("deleting a component source layer drops its now-invalid instance override on normalization", () => {
  const source = createScene({ id: "component", isComponent: true, layers: [
    createLayer("rectangle", { id: "shape", x: 0 }),
  ] });
  const main = oneScene([createLayer("component", {
    id: "instance", componentSceneId: "component", componentOverrides: { shape: { x: 10 } },
  })]);
  const base = parsed([source, main]);
  const ours = structuredClone(base), theirs = structuredClone(base);
  ours.scenes.find((scene) => scene.id === "component").layers = [];
  findLayer(theirs, "instance").componentOverrides.shape.x = 50;

  const result = mergeDocuments(base, ours, theirs);
  const saved = parseDocument(result.document);
  assert.equal(saved.scenes.find((scene) => scene.id === "component").layers.length, 0);
  assert.equal(Object.hasOwn(findLayer(saved, "instance"), "componentOverrides"), false);
});

test("canonical JSON equality ignores object key order, aliases, and undefined object fields", () => {
  const shared = { tag: "same" };
  const base = {
    id: "canonical", version: 2, name: "File",
    extension: { left: shared, right: shared },
    scenes: [{ id: "scene", layers: [], backgroundAnimations: [] }],
  };
  const ours = {
    id: "canonical", version: 2, name: "File",
    extension: { right: { tag: "same" }, left: { tag: "same" }, omitted: undefined },
    scenes: [{ id: "scene", layers: [], backgroundAnimations: [] }],
  };
  const theirs = JSON.parse(JSON.stringify(base));

  const result = mergeDocuments(base, ours, theirs);
  assert.deepEqual(result.document.extension, { right: { tag: "same" }, left: { tag: "same" } });
  assert.deepEqual(result.conflicts, []);
});

test("two saves never mix their storyboards: the board is kept whole from one side", () => {
  const shot = (id, cue, dur, text = "none") => ({ id, cue, dur, pacing: "free", media: "none", in: "none", crop: "none", subject: "none", follow: "none", text, sound: "none", why: "a line" });
  const base = parseDocument(createDocument({ id: "merge-file", name: "Merge file", scenes: [oneScene([])],
    board: { rev: 1, music: "none", shots: [shot("A", 0, 6), shot("B", 6, 6)] } }));
  const ours = structuredClone(base), theirs = structuredClone(base);
  ours.board = { ...ours.board, rev: 2, calls: ["one shot of text"], shots: [shot("A", 0, 12, { text: "Ship", family: "Inter", weight: 700, size: 54, y: 20, fill: "#ffffff" })] };
  theirs.board = { ...theirs.board, rev: 2, open: ["which song?"] };

  const result = mergeDocuments(base, ours, theirs);
  assert.deepEqual(result.document.board, ours.board, "the later save's board, not its shots with the other's open items");
  assert.deepEqual(conflictAt(result.conflicts, ["board"])?.theirs, theirs.board, "the other board is reported whole as a conflict");

  const onlyTheirs = mergeDocuments(base, structuredClone(base), theirs);
  assert.deepEqual(onlyTheirs.document.board, theirs.board);
  assert.equal(onlyTheirs.conflicts.length, 0);
});

test("merge leaves all three input documents unchanged", () => {
  const base = parsed([oneScene([createLayer("rectangle", { id: "box", x: 1, y: 2 })])]);
  const ours = structuredClone(base), theirs = structuredClone(base);
  findLayer(ours, "box").x = 3;
  findLayer(theirs, "box").y = 4;
  const snapshots = [base, ours, theirs].map((document) => structuredClone(document));

  const result = mergeDocuments(base, ours, theirs);
  assert.deepEqual([base, ours, theirs], snapshots);
  findLayer(result.document, "box").x = 999;
  assert.deepEqual([base, ours, theirs], snapshots, "editing the returned value cannot mutate an input");
});

test("merges 2,000 layers within a generous bound and reports warmed median time", (t) => {
  const layers = Array.from({ length: 2_000 }, (_, index) => ({ id: `layer-${index}`, x: index }));
  const base = { id: "large", version: 2, name: "Large", scenes: [{ id: "scene", layers, backgroundAnimations: [] }] };
  const ours = structuredClone(base), theirs = structuredClone(base);
  ours.scenes[0].layers[0].x = -1;
  theirs.scenes[0].layers.at(-1).x = -2;
  const samples = [];
  for (let run = 0; run < 5; run += 1) {
    const started = performance.now();
    const result = mergeDocuments(base, ours, theirs);
    const elapsed = performance.now() - started;
    assert.equal(result.document.scenes[0].layers.length, 2_000);
    if (run > 0) samples.push(elapsed);
  }
  const ordered = [...samples].sort((a, b) => a - b);
  const median = ordered[Math.floor(ordered.length / 2)];
  t.diagnostic(`2,000-layer merge warmed median: ${median.toFixed(1)} ms`);
  assert.ok(median < 10_000, `median ${median.toFixed(1)} ms exceeds the generous 10 s ceiling`);
});
