import assert from "node:assert/strict";
import test from "node:test";
import {
  createExportProgressRegistry,
  normalizeExportProgressId,
} from "./export-progress.mjs";

const id = (tail) => `00000000-0000-4000-8000-${String(tail).padStart(12, "0")}`;

test("export progress validates UUIDs and keeps only a minimal public snapshot", () => {
  assert.equal(normalizeExportProgressId(id(1).toUpperCase()), id(1));
  assert.throws(() => normalizeExportProgressId("../../secret"), { status: 400 });
  assert.throws(() => normalizeExportProgressId(`${id(1)}\n`), { status: 400 });

  const registry = createExportProgressRegistry();
  assert.equal(registry.create(undefined), null, "older export clients may omit the progress ID");
  const handle = registry.create(id(1), { projectId: "project-safe-id", grantId: "grant-safe-id" });
  assert.deepEqual(registry.get(id(1)), {
    id: id(1), status: "preparing", stage: null, completed: null, total: null,
  });
  assert.equal(JSON.stringify(registry.get(id(1))).includes("project-safe-id"), false);
  assert.equal(JSON.stringify(registry.get(id(1))).includes("grant-safe-id"), false);

  assert.equal(handle.progress({ stage: "render", completed: 3, total: 12 }), true);
  assert.deepEqual(registry.get(id(1)), {
    id: id(1), status: "running", stage: "render", completed: 3, total: 12,
  });
  assert.equal(handle.progress({ stage: "render", completed: 13, total: 12 }), false);
  assert.equal(handle.progress({ stage: "encode", completed: 0, total: 1 }), true);
  assert.deepEqual(registry.get(id(1)), {
    id: id(1), status: "running", stage: "encode", completed: 0, total: 1,
  }, "stage counts remain the actual renderer event rather than a synthetic percentage");
  assert.equal(handle.complete(), true);
  assert.deepEqual(registry.get(id(1)), {
    id: id(1), status: "complete", stage: "encode", completed: 0, total: 1,
  });
  assert.equal(handle.progress({ stage: "encode", completed: 1, total: 1 }), false, "terminal records do not change");
});

test("duplicate IDs conflict and invalid IDs do not create records", () => {
  const registry = createExportProgressRegistry();
  assert.throws(() => registry.create("not-a-uuid", { projectId: "project" }), { status: 400 });
  assert.equal(registry.size, 0);
  registry.create(id(2), { projectId: "project" });
  assert.throws(() => registry.create(id(2).toUpperCase(), { projectId: "project" }), { status: 409 });
  assert.equal(registry.size, 1);
});

test("terminal entries expire after five minutes and the bounded registry evicts terminal work first", () => {
  let now = 0;
  const registry = createExportProgressRegistry({ limit: 2, terminalTtlMs: 300_000, now: () => now });
  const first = registry.create(id(10), { projectId: "first" });
  first.complete();
  const active = registry.create(id(11), { projectId: "active" });
  assert.equal(registry.size, 2);
  registry.create(id(12), { projectId: "new" });
  assert.equal(registry.get(id(10)), null, "capacity pressure drops the oldest terminal result");
  assert.equal(registry.get(id(11)).status, "preparing", "active exports are retained");
  assert.throws(() => registry.create(id(13), { projectId: "full" }), { status: 503 });
  active.cancel();

  now = 300_000;
  assert.equal(registry.get(id(11)), null, "terminal polling results expire at the configured TTL");
  assert.equal(registry.size, 1);
});

test("failed and cancelled are terminal, and shutdown clear removes every record", () => {
  const registry = createExportProgressRegistry();
  const failed = registry.create(id(20), { projectId: "project" });
  const cancelled = registry.create(id(21), { projectId: "project" });
  assert.equal(failed.fail(), true);
  assert.equal(cancelled.cancel(), true);
  assert.equal(registry.get(id(20)).status, "failed");
  assert.equal(registry.get(id(21)).status, "cancelled");
  assert.equal(failed.cancel(), false);
  registry.clear();
  assert.equal(registry.size, 0);
  assert.equal(registry.get(id(20)), null);
});
