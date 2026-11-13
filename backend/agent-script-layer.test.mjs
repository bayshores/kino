// Script layers through the agent's own tools: add, change and animate one, then read it back.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAgentService } from "./agent/service.mjs";
import { createAgentStateStore } from "./agent/state.mjs";
import { openStore } from "./store.mjs";
import { createDocument, createScene } from "../engine/model.js";
import { evaluateLayer } from "../engine/animation.js";
import { blocksFinal } from "../engine/quality/index.js";
import { clearScriptFrameCache, testDrawScriptLayers } from "./script-layer-frames.mjs";

// A stand-in for the script renderer, so no Electron starts: a module with THROW in it fails after
// 1 s of layer time (line 4), one with EMPTY draws nothing, any other draws a (fake) picture.
// `renderer.frames` counts the frames it was asked for.
function fakeRenderer() {
  const renderer = {
    frames: 0,
    async render({ script, frames }) {
      renderer.frames += frames.length;
      return frames.map((frame) => {
        if (script.includes("THROW") && frame.time > 1) return { error: { message: "ReferenceError: x is not defined", phase: "draw", time: frame.time, line: 4 } };
        return { png: Buffer.from(`frame ${frame.time}`), empty: script.includes("EMPTY") };
      });
    },
  };
  return renderer;
}
const moduleWith = (marker) => `export default function setup(layer) {\n  /* ${marker} */\n  return function draw(frame) {};\n}\n`;
const scriptOp = (name, marker, extra = {}) => ({ op: "add_layer", layerType: "script", name, properties: { x: 0, y: 0, width: 400, height: 200, script: moduleWith(marker), ...extra } });

// check's frames: what the real renderer reports for the same modules (scriptIssues on each frame).
const fakeFrames = (scene, times, { width }) => times.map((time) => ({ width, height: Math.round(width * 9 / 16), pixels: new Uint8ClampedArray(width * Math.round(width * 9 / 16) * 4).fill(100),
  scriptIssues: scene.layers.filter((layer) => layer.type === "script").flatMap((layer) => {
    if (layer.script.includes("THROW") && time > 1) return [{ layerId: layer.id, kind: "error", message: `script layer "${layer.name}": ReferenceError: x is not defined at ${time.toFixed(2)} s (draw)` }];
    // LATE: a reveal that draws nothing at the very start and something after.
    return layer.script.includes("EMPTY") || (layer.script.includes("LATE") && time === 0) ? [{ layerId: layer.id, kind: "empty" }] : [];
  }) }));

async function service(t, renderer = fakeRenderer(), { realChecks = false } = {}) {
  clearScriptFrameCache();
  const dataRoot = await mkdtemp(path.join(tmpdir(), "kino-test-script-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = await openStore(dataRoot);
  await store.createProject(createDocument({ id: "p", name: "p", scenes: [createScene({ id: "s1", name: "main", duration: 4, layers: [] })] }));
  const agent = createAgentService({ store, agentState: createAgentStateStore(dataRoot), agentDirectory: path.join(dataRoot, "agent"), mediaRoot: path.join(dataRoot, "media"), scriptRenderer: renderer,
    exportBatches: {}, fontCatalog: { async loadInto() {} }, loadFonts: async () => [], listMedia: async () => [], operationContext: async () => ({}),
    ...(realChecks ? { renderFrames: fakeFrames } : { quality: { async check() { return { findings: [], notes: [], ms: 0, unchecked: [], scenes: 1 }; } } }),
    saveDocument: (projectId, before, saved, revision, options) => store.updateProject(projectId, saved, revision, options) });
  const edit = (ops) => agent.call("edit", { project: "p", ops });
  const layer = async (name) => (await store.getProject("p")).document.scenes[0].layers.find((entry) => entry.name === name);
  return { agent, edit, layer, renderer };
}

// Each example in the reference: a js block (the module), then a json block with the add_layer op
// that carries the same module.
async function referenceExamples() {
  const text = await readFile(new URL("../skills/kino/references/script-layers.md", import.meta.url), "utf8");
  const blocks = [...text.matchAll(/```(js|json)\n([\s\S]*?)```/g)].map(([, kind, body]) => ({ kind, body }));
  return blocks.flatMap((block, index) => {
    if (block.kind !== "json" || blocks[index - 1]?.kind !== "js") return [];
    const op = JSON.parse(block.body);
    assert.equal(op.properties.script, blocks[index - 1].body, `the ${op.name} op carries the module shown above it`);
    return [op];
  });
}

test("an agent adds a script layer, changes and animates its inputs, and reads them in status and inspect", async (t) => {
  const { agent, edit, layer } = await service(t);
  const [bars] = await referenceExamples();
  const added = await edit([bars, { op: "add_animation", layer: "bars", animation: { kind: "custom", start: 0, duration: 2, easing: "linear",
    from: { values: { reveal: 0 } }, to: { values: { reveal: 1 } } } }]);
  assert.equal(added.isError, undefined, added.text);
  const merged = await edit([{ op: "update_layer", layer: "bars", properties: { values: { tint: "#3366ff" } } }]);
  assert.equal(merged.isError, undefined, merged.text);
  const saved = await layer("bars");
  assert.deepEqual(saved.values, { reveal: 1, tint: "#3366ff" });
  assert.equal(evaluateLayer(saved, 1).values.reveal, 0.5);

  const status = (await agent.call("status", { project: "p", full: true })).text;
  assert.match(status, /L1 bars script 160,200 800×500 inputs reveal=1 \(animated\), tint=#3366ff \| A1 custom values 0–2/);
  assert.doesNotMatch(status, /getContext/, "status leaves the code out");
  assert.match((await agent.call("inspect", { project: "p", target: "bars" })).text, /getContext/);

  const removed = await edit([{ op: "update_layer", layer: "bars", properties: { inputs: [{ key: "tint", type: "color" }] } }]);
  assert.equal(removed.isError, true);
  assert.match(removed.text, /Input \\"reveal\\" can't be removed: the animation \\"Custom\\" still moves it/);
  const broken = await edit([{ op: "update_layer", layer: "bars", properties: { script: "export default function setup() {\n  return (\n}" } }]);
  assert.match(broken.text, /syntax error at line 3/);
});

test("a refused script layer edit ends with a script layer example to send again", async (t) => {
  const { edit } = await service(t);
  const [bars] = await referenceExamples();
  const refused = await edit([{ ...bars, properties: { ...bars.properties, script: "export default function setup() {\n  return (\n}" } }]);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /syntax error at line 3/);
  // The reply's `next` is `edit {retry, fix: {<op number>: <the op to send instead>}}`.
  const nextOf = (reply) => JSON.stringify(JSON.parse(JSON.parse(reply.text).next.replace(/^edit /, "")).fix);
  assert.match(nextOf(refused), /"layerType":"script"[\s\S]*getContext/);
  await edit([bars]);
  const animation = await edit([{ op: "add_animation", layer: "bars", animation: { kind: "custom", start: 0, duration: 1, from: { values: { nope: 0 } }, to: { values: { nope: 1 } } } }]);
  assert.equal(animation.isError, true, animation.text);
  assert.match(nextOf(animation), /"values":\{"reveal":1\}/);
});

const warningsOf = (reply) => JSON.parse(reply.text).warnings ?? [];

test("the receipt tells a throwing script layer's error, and the edit is still saved", async (t) => {
  const { edit, layer, renderer } = await service(t);
  const reply = await edit([scriptOp("bad", "THROW")]);
  assert.equal(reply.isError, undefined, reply.text);
  assert.deepEqual(warningsOf(reply), ['script "bad": ReferenceError: x is not defined at 2.00 s (draw, line 4)']);
  assert.equal((await layer("bad")).type, "script");
  assert.equal(renderer.frames, 3, "start, middle and end of the layer's time");
});

test("the receipt tells a script layer that drew nothing, with the times", async (t) => {
  const { edit } = await service(t);
  const reply = await edit([scriptOp("blank", "EMPTY")]);
  assert.deepEqual(warningsOf(reply), ['script "blank" drew nothing at 0.00 s, 2.00 s and 4.00 s']);
});

test("a script layer that draws fine adds no line, and an edit without one never starts a renderer", async (t) => {
  const { edit, renderer } = await service(t);
  const reply = await edit([scriptOp("fine", "FINE")]);
  assert.deepEqual(warningsOf(reply), []);
  assert.equal(renderer.frames, 3);
  // Moving the layer or adding a rectangle changes nothing the script draws.
  const other = await edit([{ op: "update_layer", layer: "fine", properties: { x: 50 } }, { op: "add_layer", layerType: "rectangle", name: "box", properties: { width: 50, height: 50 } }]);
  assert.equal(other.isError, undefined, other.text);
  assert.equal(renderer.frames, 3, "no new frames were drawn");
});

test("a dry run test-draws too, and saves nothing", async (t) => {
  const { agent, layer } = await service(t);
  const reply = await agent.call("edit", { project: "p", dry_run: true, ops: [scriptOp("ghost", "THROW")] });
  assert.match(warningsOf(reply)[0], /^script "ghost": ReferenceError/);
  assert.equal(await layer("ghost"), undefined);
});

test("a test draw that has not answered in time is skipped with one line, and a missing renderer says nothing", async () => {
  const layer = { id: "L1", type: "script", name: "slow", x: 0, y: 0, width: 100, height: 50, script: moduleWith("SLOW"), inputs: [], values: {}, animations: [] };
  const after = { scenes: [{ id: "s1", width: 200, height: 100, duration: 2, layers: [layer] }] };
  const slow = { render: () => new Promise(() => {}) };
  assert.deepEqual(await testDrawScriptLayers({ scenes: [] }, after, { renderer: slow, timeoutMs: 40 }), ["script test draw skipped: no answer in 0 s"]);
  const gone = { render: async () => { throw new Error("The Electron runtime for script layers was not found."); } };
  assert.deepEqual(await testDrawScriptLayers({ scenes: [] }, after, { renderer: gone }), []);
});

test("check: a failing script layer is an error with the update_layer fix, an empty one a warning, and a waiver quiets the error", async (t) => {
  const { agent, edit } = await service(t, fakeRenderer(), { realChecks: true });
  const added = await edit([scriptOp("bad", "THROW"), scriptOp("blank", "EMPTY"), scriptOp("reveal", "LATE")]);
  assert.equal(added.isError, undefined, added.text);
  const failing = await agent.call("check", { project: "p", rules: ["script_layer_error"] });
  assert.match(failing.text, /script_layer_error/, failing.text);
  assert.match(failing.text, /script layer "bad": ReferenceError: x is not defined at 2\.00 s \(draw\)/);
  assert.match(failing.text, /update_layer/);
  assert.match(failing.text, /<fixed module>/);
  assert.doesNotMatch(failing.text, /blank/, "the empty layer is not an error");
  const empty = await agent.call("check", { project: "p", rules: ["script_layer_empty"] });
  assert.match(empty.text, /blank/, empty.text);
  assert.match(empty.text, /drew nothing at 0 s, /);
  assert.doesNotMatch(empty.text, /reveal/, "a layer that is empty only at its start is not warned about");
  // An error blocks a final render even in a draft-quality project (blocksFinal, the function the render asks); a warning only in a real edit.
  assert.equal(blocksFinal({ rule: "script_layer_error", severity: "error" }, false), true);
  assert.equal(blocksFinal({ rule: "script_layer_empty", severity: "warn" }, false), false);

  const waived = await edit([{ op: "waive_check", code: "script_layer_error", target: "bad", reason: "the demo draws late on purpose" }]);
  assert.equal(waived.isError, undefined, waived.text);
  assert.doesNotMatch((await agent.call("check", { project: "p", rules: ["script_layer_error"] })).text, /script layer "bad"/);
});

test("every example in the script layer reference is a valid add_layer", async (t) => {
  const { edit, layer } = await service(t);
  const examples = await referenceExamples();
  assert.equal(examples.length, 3);
  const result = await edit(examples);
  assert.equal(result.isError, undefined, result.text);
  for (const example of examples) assert.equal((await layer(example.name)).type, "script");
});
