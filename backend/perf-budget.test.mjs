// The Efficiency rules' guard (AGENTS.md): what one agent call may cost, counted in operations
// (store parses and writes, agent state writes, font registries built), not in milliseconds, so
// a busy machine cannot fail it. The counts must be the same with 1 project and with 20, and
// within tests/perf-budget.json. Raising a budget is an edit to that file.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { createAgentService } from "./agent/service.mjs";
import { createAgentStateStore, stateCounters } from "./agent/state.mjs";
import { fontCounters, loadProjectFonts } from "./fonts.mjs";
import { openStore, storeCounters } from "./store.mjs";

const budgets = JSON.parse(await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tests", "perf-budget.json"), "utf8"));

const counts = () => ({ storeParses: storeCounters.parses, storeWrites: storeCounters.writes, stateWrites: stateCounters.writes, fontRegistriesBuilt: fontCounters.registriesBuilt });

async function callCosts(projects) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "kino-perf-budget-"));
  try {
    const mediaRoot = path.join(dataRoot, "media");
    await mkdir(mediaRoot, { recursive: true });
    const store = await openStore(dataRoot);
    for (let index = 0; index < projects; index += 1) {
      const layers = [createLayer("text", { id: "title", name: "title", text: "kino", x: 100, y: 100, width: 600, height: 120, fontSize: 96 }),
        createLayer("rectangle", { id: "box", name: "box", x: 100, y: 400, width: 200, height: 200 })];
      await store.createProject(createDocument({ id: `p${index}`, name: `p${index}`, scenes: [createScene({ id: "s1", duration: 4, layers })] }));
    }
    const service = createAgentService({
      store, agentState: createAgentStateStore(dataRoot), agentDirectory: path.join(dataRoot, "agent"), mediaRoot,
      exportBatches: {}, fontCatalog: { async loadInto() {} }, loadFonts: () => loadProjectFonts({ mediaRoot }), operationContext: async () => ({}),
      quality: { async check() { return { findings: [], notes: [], ms: 0, unchecked: [], scenes: 1 }; } },
      saveDocument: (projectId, before, document, expectedRevision, options = {}) => store.updateProject(projectId, document, expectedRevision, options),
    });
    const meta = { client: "claude-code", session: "perf-budget" };
    const call = async (verb, input) => {
      const answer = await service.call(verb, { project: "p0", ...input }, meta);
      assert.equal(answer.isError, undefined, answer.text);
    };
    // The first calls load fonts and write the project's first agent state: not what is counted.
    await call("status");
    await call("edit", { ops: [{ op: "update_layer", layer: "box", properties: { x: 110 } }] });
    const costs = {};
    for (const [verb, input] of [["status", {}], ["inspect", { targets: ["s1"] }], ["check", { pixels: false }], ["edit", { ops: [{ op: "update_layer", layer: "box", properties: { x: 120 } }] }]]) {
      const before = counts();
      await call(verb, input);
      const after = counts();
      costs[verb] = Object.fromEntries(Object.keys(after).map((name) => [name, after[name] - before[name]]));
    }
    return costs;
  } finally { await rm(dataRoot, { recursive: true, force: true }); }
}

test("an agent call costs the same with 1 project and with 20, within tests/perf-budget.json", async () => {
  const one = await callCosts(1);
  const twenty = await callCosts(20);
  assert.deepEqual(twenty, one, "a call's cost must not grow with the number of projects");
  for (const [verb, cost] of Object.entries(one)) for (const [name, count] of Object.entries(cost))
    assert.ok(count <= budgets.calls[verb][name], `${verb}: ${name} is ${count}, over its budget of ${budgets.calls[verb][name]} (tests/perf-budget.json)`);
});
