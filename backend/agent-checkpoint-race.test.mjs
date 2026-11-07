// A stop asked while an agent write to the same project is still running (review round 2 of
// B2a). The write passed the waiting check before the stop existed, so without care it would save
// after the stop's waiting_for_you told the agent to wait: the stop was born stale, and the
// person's reply to it was refused. Now either the write's save comes first and the ask sees the
// new revision (check_first), or the ask comes first and the write is refused with {waiting}.
// The fake quality checker and save below stop at the worst moment every time, without
// rendering anything.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDocument, createScene } from "../engine/model.js";
import { createAgentService } from "./agent/service.mjs";
import { createAgentStateStore } from "./agent/state.mjs";
import { loadBundledFonts } from "./fonts.mjs";
import { openStore } from "./store.mjs";

const PROJECT = "stop-race";
const TITLE = { op: "add_layer", layerType: "text", name: "title", properties: { text: "Park reopens Saturday", x: 140, y: 760, width: 800, height: 240, fontSize: 96, fill: "#ffffff" } };
const move = (y) => ({ op: "update_layer", layer: "title", properties: { y } });

// A pause the test opens: `reached` resolves when the code under test arrives at it.
function pause() {
  let arrive, open;
  const reached = new Promise((resolve) => { arrive = resolve; });
  const opened = new Promise((resolve) => { open = resolve; });
  return { reached, open, async wait() { arrive(); await opened; } };
}

async function setup(t) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "kino-stop-race-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = await openStore(dataRoot);
  await store.createProject(createDocument({ id: PROJECT, name: "Stop race", scenes: [createScene({ id: "s1", width: 1080, height: 1920, duration: 24 })] }));
  const fonts = await loadBundledFonts();
  const pauses = { check: null, save: null };
  const service = createAgentService({
    store, agentState: createAgentStateStore(dataRoot), agentDirectory: path.join(dataRoot, "agent"), mediaRoot: path.join(dataRoot, "media"),
    exportBatches: {}, fontCatalog: { async loadInto() {} }, loadFonts: async () => fonts,
    operationContext: async () => ({}),
    // No pixels: the check finds nothing, and it can stop inside an edit before the save.
    quality: { async check() { await pauses.check?.wait(); return { findings: [], notes: [], ms: 0, unchecked: [], scenes: 1 }; } },
    async saveDocument(projectId, before, document, expectedRevision, { request, resultMetadata } = {}) {
      await pauses.save?.wait();
      return store.updateProject(projectId, document, expectedRevision, { request, resultMetadata });
    },
  });
  const call = (verb, input) => service.call(verb, { project: PROJECT, ...input }, { client: "claude-code" });
  // The fixture, a brief settled with no playback and the agent's full check of its revision.
  assert.equal((await call("edit", { ops: [TITLE] })).isError, undefined);
  assert.equal((await call("notes", { action: "brief", no_playback: "just start" })).isError, undefined);
  const checked = await call("check", {});
  assert.equal(checked.data.errors, 0, checked.text);
  const rev = (await store.getProject(PROJECT)).revision;
  return { store, call, pauses, rev };
}

test("an edit still running when the stop is asked is refused at its save: nothing reaches the project after waiting_for_you", async (t) => {
  const { store, call, pauses, rev } = await setup(t);
  // The edit has applied its operations and is checking the result, before its save.
  const checking = pauses.check = pause();
  const editing = call("edit", { ops: [move(700)] });
  await checking.reached;
  pauses.check = null;

  const asked = await call("notes", { action: "checkpoint", id: "rough" });
  assert.equal(asked.data.status, "waiting_for_you", asked.text);
  assert.equal(asked.data.rev, rev);

  checking.open();
  const edited = await editing;
  assert.equal(edited.isError, undefined, edited.text);
  assert.deepEqual(edited.data, { waiting: "C1", kind: "rough",
    next: "Nothing was changed. C1 (the rough cut) waits for the person's answer: end your turn. Reads, look, check and notes still work." });
  assert.equal((await store.getProject(PROJECT)).revision, rev, "the edit saved nothing");
  const status = await call("status", {});
  assert.equal(status.data.waiting, "C1", "the stop still stands for the revision the person is shown");
  assert.equal(status.text.split("\n")[2], "step: end your turn until they answer");
});

test("a stop asked while an edit is saving waits for that save, then sees the new revision: check_first, no stop born stale", async (t) => {
  const { store, call, pauses, rev } = await setup(t);
  // The edit is inside its save when the agent (or a second agent) asks the stop.
  const saving = pauses.save = pause();
  const editing = call("edit", { ops: [move(700)] });
  await saving.reached;
  pauses.save = null;
  let askedFirst = false;
  const asking = call("notes", { action: "checkpoint", id: "rough" }).then((reply) => { askedFirst = true; return reply; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(askedFirst, false, "the ask waits for the save that is running");

  saving.open();
  const [edited, asked] = await Promise.all([editing, asking]);
  assert.equal(edited.isError, undefined, edited.text);
  assert.equal(edited.data.rev, rev + 1);
  assert.equal(asked.isError, true, asked.text);
  assert.equal(asked.data.error, "check_first", asked.text);
  assert.equal(asked.data.reason, `Run check first: a stop shows work kino checked on this revision (rev ${rev + 1}; last full check: rev ${rev}).`);
  assert.equal((await store.getProject(PROJECT)).revision, rev + 1);
  assert.equal((await call("status", {})).data.waiting, undefined, "no stop waits on a revision that is gone");
});
