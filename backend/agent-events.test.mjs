// The dashboard's event list survives a restart: a new store (a restarted server) that records
// an event before anything read the list still returns the saved older events, so the
// dashboard can say which agent made an older turn.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAgentStateStore } from "./agent/state.mjs";

test("events recorded before a restart are still listed after one, before and after a new event", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "kino-events-"));
  try {
    const first = createAgentStateStore(dataRoot);
    await first.record("p1", { verb: "edit", agent: { id: "a1", name: "Nova" }, turn: "T1" });
    await first.record("p1", { verb: "look", agent: { id: "a1", name: "Nova" }, turn: "T1" });

    const restarted = createAgentStateStore(dataRoot);
    await restarted.record("p1", { verb: "edit", agent: { id: "a1", name: "Juno" }, turn: "T2" });
    const list = await restarted.events("p1");
    assert.deepEqual(list.map((event) => `${event.turn} ${event.verb} ${event.agent.name}`), ["T1 edit Nova", "T1 look Nova", "T2 edit Juno"]);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
