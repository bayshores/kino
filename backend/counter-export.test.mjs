// The Counter operation outside the editor: Lottie, PNG stills and the PNG frames that GIF and
// video encode, the saved project store and the agent's edit tool.
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
import { MAX_COUNTER_UNIT_LAYERS } from "./lottie-text.mjs";
import { readImage } from "./media.test.support.mjs";
import { openStore } from "./store.mjs";

const fonts = await loadBundledFonts();

// The agent's edit tool (POST /api/agent/edit) on a store of its own, holding `document`.
async function agentEdit(t, document) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "kino-counter-agent-"));
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

function counter(fields = {}) {
  return { id: "count", name: "Counter", kind: "counter", start: 0.5, duration: 1, easing: "linear", from: 0, to: 10, step: 1, out: null, in: null, ...fields };
}

function score(overrides = {}) {
  return createLayer("text", { id: "t", name: "Score", x: 20, y: 40, width: 100, height: 48, text: "0", fontSize: 40, textAlign: "center", textResize: "width-height", fill: "#000000", ...overrides });
}

function scene(layers, { width = 300, height = 140, duration = 2 } = {}) {
  return createScene({ id: "scene", name: "Scene", width, height, duration, background: "#ffffff", layers });
}

async function lottie(input, fps = 10) {
  const result = await exportScene(input, { format: "lottie", fps }, { fonts });
  return { result, animation: JSON.parse(result.buffer.toString("utf8")) };
}

// [text, st, ip, op] of every exported text layer, in the order they are drawn (bottom first).
function runs(animation) {
  return animation.layers.filter((layer) => layer.nm.startsWith("Score")).reverse()
    .map((layer) => [layer.nm.match(/“(.*)”/u)[1], layer.st, layer.ip, layer.op]);
}

function opacityKeys(layer) {
  return layer.ks.o.a === 1 ? layer.ks.o.k.map((key) => [key.t, Math.round(key.s[0] * 10) / 10]) : layer.ks.o.k;
}

async function pixels(input, time) {
  const image = await readImage((await exportScene(input, { format: "png", time }, { fonts })).buffer);
  const values = [];
  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) values.push(...image.pixel(x, y));
  return values;
}

test("Lottie gives each number its own layers, shown only on the frames that count it", async () => {
  // 0 to 10 from 0.5 s to 1.5 s at 10 frames a second: one number per frame.
  const { result, animation } = await lottie(scene([score({ animations: [counter()] })]));
  assert.equal(result.warnings, undefined);
  assert.deepEqual(runs(animation), [
    ["0", 0, 0, 5], // the layer's own text before the start
    ["0", 5, 5, 6], ["1", 6, 6, 7], ["2", 7, 7, 8], ["3", 8, 8, 9], ["4", 9, 9, 10],
    ["5", 10, 10, 11], ["6", 11, 11, 12], ["7", 12, 12, 13], ["8", 13, 13, 14], ["9", 14, 14, 15],
    ["10", 15, 15, 20], // To stays until the end of the file
  ]);
  // A slower count holds each number for several frames, in one layer per number.
  const slow = await lottie(scene([score({ animations: [counter({ start: 0, duration: 2, to: 2, easing: "linear" })] })]));
  // 2 comes on the final frame boundary (2 s), after the last frame, so it has no layer.
  assert.deepEqual(runs(slow.animation), [["0", 0, 0, 10], ["1", 10, 10, 20]]);
});

test("Lottie keeps each step's effects, keyed in the containing composition's time", async () => {
  // Steps at 0.5 s and 1 s; each 0.2 s fade fits before the next step, so it plays in full.
  const input = scene([score({ animations: [counter({ start: 0, duration: 1, to: 2, out: effect("fade-out", { duration: 0.2 }), in: effect("fade-in", { duration: 0.2 }) })] })]);
  const { result, animation } = await lottie(input);
  assert.equal(result.warnings, undefined);
  assert.deepEqual(runs(animation), [["0", 0, 0, 7], ["1", 5, 5, 12], ["2", 10, 10, 20]]);
  const [zero, one, two] = animation.layers.filter((layer) => layer.nm.startsWith("Score")).reverse();
  // "0" is the text already there, so it shows from the start without an effect, then fades
  // out from 0.5 s (frame 5) until it is gone at 0.7 s (its out point, frame 7).
  assert.deepEqual(opacityKeys(zero).slice(4), [[4, 100], [5, 100], [6, 50], [7, 0]]);
  // Lottie properties are timed in their containing composition. `st` shifts a
  // precomposition's child clock; it does not shift the layer's own keyframes.
  // "1" fades in at frames 5–7, then out from frame 10 (1 s).
  assert.deepEqual(opacityKeys(one).slice(0, 3), [[5, 0], [6, 50], [7, 100]]);
  assert.deepEqual(opacityKeys(one).slice(5), [[10, 100], [11, 50], [12, 0]]);
  // The last number fades in and stays.
  assert.deepEqual(opacityKeys(two).slice(0, 3), [[10, 0], [11, 50], [12, 100]]);
});

test("Lottie leaves out the effects of a Counter that shows too many numbers for them, with a warning", async () => {
  // A new number on every frame, each fading in letter by letter: about 18 letters on each of
  // 300 frames is past the limit.
  const fade = effect("fade-in", { unit: "letters", stagger: 0.001, duration: 0.01 });
  const input = scene([score({ text: "Total: 100000 points", animations: [counter({ start: 0, duration: 5, from: 100000, to: 999999, in: fade, out: { ...fade, preset: "fade-out" } })] })], { width: 600, duration: 5 });
  const { result, animation } = await lottie(input, 60);
  assert.deepEqual(result.warnings.map((warning) => warning.code), ["lottie-counter-effects-simplified"]);
  assert.match(result.warnings[0].message, /Score.*without them/u);
  const layers = animation.layers.filter((layer) => layer.nm.startsWith("Score"));
  assert.ok(layers.length <= 301 && layers.length < MAX_COUNTER_UNIT_LAYERS, `${layers.length} layers, one per number`);
  // Without effects each number is fully shown on its frame.
  assert.ok(layers.every((layer) => layer.ks.o.a === 0 && layer.ks.o.k === 100));
});

test("a PNG still shows the number counted at that time, as a layer saved with that text", async () => {
  const animated = scene([score({ text: "$0", animations: [counter()] })]);
  assert.deepEqual(await pixels(animated, 1), await pixels(scene([score({ text: "$5" })]), 0), "$5 halfway");
  assert.deepEqual(await pixels(animated, 1.5), await pixels(scene([score({ text: "$10" })]), 0), "exactly To at the end");
  assert.deepEqual(await pixels(animated, 0.25), await pixels(scene([score({ text: "$0" })]), 0), "its own text before the start");
});

test("the PNG frames GIF and video are made from match the stills at each time", async (t) => {
  const animated = scene([score({ animations: [counter({ start: 0, duration: 1, to: 4, in: effect("slide-up", { duration: 0.1, distance: 10 }) })] })], { duration: 1 });
  const directory = await mkdtemp(path.join(os.tmpdir(), "kino-counter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sequenceDirectory = path.join(directory, "frames");
  await mkdir(sequenceDirectory);
  await exportScene(animated, { format: "png-sequence", fps: 8 }, { fonts, sequenceDirectory });
  const names = (await readdir(sequenceDirectory)).sort();
  assert.equal(names.length, 8);
  const frames = [];
  for (const [index, name] of names.entries()) {
    const image = await readImage(await readFile(path.join(sequenceDirectory, name)));
    const frame = [];
    for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) frame.push(...image.pixel(x, y));
    assert.deepEqual(frame, await pixels(animated, index / 8), `${name} is the still at ${index / 8} s`);
    frames.push(frame);
  }
  assert.notDeepEqual(frames[0], frames[7], "the frames count");
});

test("the store saves and reopens a Counter, and the agent's edit adds, changes and refuses one", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "kino-counter-store-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "data");
  const document = createDocument({ id: "saved_project", name: "Saved project", scenes: [scene([score({ text: "0000", animations: [counter({ from: 998, to: 1001, in: effect("fade-in") })] })])] });
  await (await openStore(root)).createProject(document);
  const reopened = await (await openStore(root)).getProject("saved_project");
  const saved = reopened.document.scenes[0].layers[0].animations[0];
  assert.deepEqual([saved.kind, saved.from, saved.to, saved.step, saved.in.preset, saved.out], ["counter", 998, 1001, 1, "fade-in", null]);

  // The agent's edit tool, in this process on its own store.
  const { edit, read } = await agentEdit(t, createDocument({ id: "agent_file", name: "Agent file", scenes: [scene([score({ text: "Score: 42" }), score({ id: "word", name: "Word", text: "Hello" }), createLayer("rectangle", { id: "box", name: "Box" })])] }));
  const added = await edit([{ op: "add_animation", layer: "Score", preset: "counter", start: 0.25 }]);
  assert.equal(added.isError, undefined, added.text);
  const animation = (await read()).scenes[0].layers[0].animations[0];
  assert.deepEqual([animation.kind, animation.start, animation.from, animation.to, animation.step], ["counter", 0.25, 42, 142, 1]);
  const edited = await edit([{ op: "update_animation", layer: "Score", animation: animation.id, properties: { to: 0, step: 2, out: effect("blur-out") } }]);
  assert.equal(edited.isError, undefined, edited.text);
  const updated = (await read()).scenes[0].layers[0].animations[0];
  assert.deepEqual([updated.to, updated.step, updated.out.preset], [0, 2, "blur-out"]);

  const refused = await edit([{ op: "add_animation", layer: "Word", preset: "counter" }]);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /A Counter needs a number in the text, such as 0, 42%, or \$1,234\.50; “Hello” has no digits\./);
  const notText = await edit([{ op: "add_animation", layer: "Box", preset: "counter" }]);
  assert.equal(notText.isError, true);
  assert.match(notText.text, /A Counter needs a text layer/);
  const unit = await edit([{ op: "update_animation", layer: "Score", animation: animation.id, properties: { unit: "letters" } }]);
  assert.equal(unit.isError, true);
  assert.match(unit.text, /unit/);
});
