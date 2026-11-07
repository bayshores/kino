// The Change text operation outside the editor: Lottie, PNG stills and the PNG frames that GIF
// and video encode, the saved project store and the agent edit tool.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { createAgentService } from "./agent/service.mjs";
import { createAgentStateStore } from "./agent/state.mjs";
import { exportScene } from "./export.mjs";
import { loadBundledFonts } from "./fonts.mjs";
import { readImage } from "./media.test.support.mjs";
import { openStore } from "./store.mjs";

const fonts = await loadBundledFonts();

// The agent's edit tool (POST /api/agent/edit) on a store of its own, holding `document`.
async function agentEdit(t, document) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "kino-text-change-agent-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = await openStore(dataRoot);
  await store.createProject(document);
  const service = createAgentService({
    store, agentState: createAgentStateStore(dataRoot), agentDirectory: path.join(dataRoot, "agent"), mediaRoot: path.join(dataRoot, "media"),
    exportBatches: {}, fontCatalog: { async loadInto() {} }, loadFonts: async () => fonts, operationContext: async () => ({ fonts }),
    // No quality pass: this checks what the edit saves, not the check's findings.
    quality: { async check() { return { findings: [], notes: [], ms: 0, unchecked: [], scenes: 1 }; } },
    saveDocument: (projectId, before, saved, revision, options) => store.updateProject(projectId, saved, revision, options),
  });
  return {
    edit: (ops) => service.call("edit", { project: document.id, ops }),
    read: async () => (await store.getProject(document.id)).document,
  };
}

function effect(preset, overrides = {}) {
  return { preset, duration: 0.5, easing: "linear", unit: "layer", stagger: 0, order: "forward", ...overrides };
}

function change(start, text, { id = "swap", out = effect("fade-out"), into = effect("fade-in"), overlap = false } = {}) {
  return { id, name: "Change text", kind: "change-text", start, text, overlap, out, in: into };
}

function title(overrides = {}) {
  return createLayer("text", { id: "t", name: "Title", x: 20, y: 40, width: 100, height: 48, text: "Hello", fontSize: 40, textAlign: "center", textResize: "width-height", fill: "#000000", ...overrides });
}

function scene(layers, { width = 300, height = 140, duration = 3 } = {}) {
  return createScene({ id: "scene", name: "Scene", width, height, duration, background: "#ffffff", layers });
}

async function lottie(input, fps = 10) {
  const result = await exportScene(input, { format: "lottie", fps }, { fonts });
  return { result, animation: JSON.parse(result.buffer.toString("utf8")) };
}

// The [ip, op] of every exported layer of one string ("Title (text 1)" is the layer's own text).
function stringTimes(animation, string) {
  return animation.layers.filter((layer) => layer.nm.startsWith(`Title (text ${string})`)).map((layer) => [layer.ip, layer.op]);
}

function opacityAt(layer, frame) {
  const keys = layer.ks.o.k;
  return layer.ks.o.a === 1 ? keys.find((key) => key.t === frame).s[0] : keys;
}

async function pixels(input, time) {
  const image = await readImage((await exportScene(input, { format: "png", time }, { fonts })).buffer);
  const values = [];
  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) values.push(...image.pixel(x, y));
  return values;
}

test("Lottie gives each string its own layers, drawn only on the frames that show it", async () => {
  // Out then In: Hello until 1.5 s (frame 15), World from 1.5 s.
  const { result, animation } = await lottie(scene([title({ animations: [change(1, "World")] })]));
  assert.equal(result.warnings, undefined, "exported exactly at frame granularity");
  assert.deepEqual(stringTimes(animation, 1), [[0, 15]]);
  assert.deepEqual(stringTimes(animation, 2), [[15, 30]]);
  const [old] = animation.layers.filter((layer) => layer.nm.startsWith("Title (text 1)"));
  const [next] = animation.layers.filter((layer) => layer.nm.startsWith("Title (text 2)"));
  const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual}`);
  near(opacityAt(old, 10), 100, "the old text before its Out effect");
  near(opacityAt(old, 12), 60, "the Out effect fades the old text");
  near(opacityAt(next, 15), 0, "the new text as it appears");
  near(opacityAt(next, 18), 60, "the In effect fades the new text in");
  near(opacityAt(next, 25), 100, "the new text after its In effect");

  // Overlap: World from 1 s, while Hello fades until 1.5 s.
  const overlap = await lottie(scene([title({ animations: [change(1, "World", { overlap: true })] })]));
  assert.deepEqual(stringTimes(overlap.animation, 1), [[0, 15]]);
  assert.deepEqual(stringTimes(overlap.animation, 2), [[10, 30]]);

  // An instant swap at a frame boundary: the new text is on that frame.
  const instant = await lottie(scene([title({ animations: [change(1, "World", { out: null, into: null })] })]));
  assert.deepEqual(stringTimes(instant.animation, 1), [[0, 10]]);
  assert.deepEqual(stringTimes(instant.animation, 2), [[10, 30]]);
});

test("Lottie exports a letter-by-letter In effect as one layer per letter of the new text, and chains changes", async () => {
  const layer = title({ animations: [change(1, "Hey", { out: null, into: effect("slide-up", { unit: "letters", stagger: 0.1, distance: 30 }) }), change(2, "Bye", { id: "later" })] });
  const { result, animation } = await lottie(scene([layer]));
  assert.equal(result.warnings, undefined);
  assert.deepEqual(stringTimes(animation, 1), [[0, 10]]);
  // "Hey": three letters, each from 1 s until "Bye" replaces it after its Out effect (2.5 s).
  assert.deepEqual(stringTimes(animation, 2), [[10, 25], [10, 25], [10, 25]]);
  assert.deepEqual(stringTimes(animation, 3), [[25, 30]]);
  // The letters rise one after another: at 1.2 s the first has moved further up than the last.
  const letters = animation.layers.filter((item) => item.nm.startsWith("Title (text 2)")).reverse();
  const y = (item, frame) => item.ks.p.k.find((key) => key.t === frame).s[1];
  assert.ok(y(letters[0], 12) < y(letters[2], 12));
});

test("a PNG still after the effects matches a layer saved with the new text, and the frames change", async () => {
  const animated = scene([title({ animations: [change(1, "World")] })]);
  const still = scene([title({ text: "World" })]);
  assert.deepEqual(await pixels(animated, 2.5), await pixels(still, 0), "World, in its own box at the same center");
  assert.deepEqual(await pixels(animated, 0.5), await pixels(scene([title()]), 0), "Hello before the change");
  assert.notDeepEqual(await pixels(animated, 1.25), await pixels(animated, 0.5), "the Out effect fades it");
});

test("the PNG frames GIF and video are made from match the stills at each time", async (t) => {
  const animated = scene([title({ animations: [change(0.25, "Hi there", { overlap: true, into: effect("fade-in", { unit: "words", stagger: 0.25 }) })] })], { duration: 1 });
  const directory = await mkdtemp(path.join(os.tmpdir(), "kino-text-change-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sequenceDirectory = path.join(directory, "frames");
  await mkdir(sequenceDirectory);
  await exportScene(animated, { format: "png-sequence", fps: 4 }, { fonts, sequenceDirectory });
  const names = (await readdir(sequenceDirectory)).sort();
  assert.equal(names.length, 4);
  const frames = [];
  for (const [index, name] of names.entries()) {
    const image = await readImage(await readFile(path.join(sequenceDirectory, name)));
    const frame = [];
    for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) frame.push(...image.pixel(x, y));
    assert.deepEqual(frame, await pixels(animated, index / 4), `${name} is the still at ${index / 4} s`);
    frames.push(frame);
  }
  assert.notDeepEqual(frames[0], frames[3], "the frames change");
});

test("the store saves and reopens a Change text, and the agent edit adds, changes and refuses one", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "kino-text-change-store-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "data");
  const document = createDocument({ id: "saved_project", name: "Saved project", scenes: [scene([title({ animations: [change(1, "World", { into: effect("slide-down", { distance: 12 }) })] })])] });
  await (await openStore(root)).createProject(document);
  const reopened = await (await openStore(root)).getProject("saved_project");
  const saved = reopened.document.scenes[0].layers[0].animations[0];
  assert.equal(saved.kind, "change-text");
  assert.equal(saved.text, "World");
  assert.deepEqual(saved.in, effect("slide-down", { distance: 12 }));

  const { edit, read } = await agentEdit(t, createDocument({ id: "agent_file", name: "Agent file", scenes: [scene([title(), createLayer("rectangle", { id: "box", name: "Box" })])] }));
  const added = await edit([{ op: "add_animation", layer: "Title", preset: "change-text", start: 0.5 }]);
  assert.equal(added.isError, undefined, added.text);
  const animation = (await read()).scenes[0].layers[0].animations[0];
  assert.equal(animation.kind, "change-text");
  assert.equal(animation.start, 0.5);
  const edited = await edit([{ op: "update_animation", layer: "Title", animation: animation.id, properties: { text: "Bye", out: null } }]);
  assert.equal(edited.isError, undefined, edited.text);
  const changed = (await read()).scenes[0].layers[0].animations[0];
  assert.equal(changed.text, "Bye");
  assert.equal(changed.out, null);

  const refused = await edit([{ op: "add_animation", layer: "Box", preset: "change-text" }]);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /Change text needs a text layer/);
  const timed = await edit([{ op: "update_animation", layer: "Title", animation: animation.id, properties: { duration: 2 } }]);
  assert.equal(timed.isError, true);
  assert.match(timed.text, /cannot have duration/);
});
