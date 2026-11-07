// House memory (house-memory.mjs): a copy is one family with its project and is never read back
// for it; other projects are.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHouseMemory, familyOf } from "./house-memory.mjs";

test("familyOf drops copies and a trailing number", () => {
  assert.equal(familyOf("Promo [copy] [copy]"), "promo");
  assert.equal(familyOf("Promo v2"), "promo");
  assert.equal(familyOf("promo-3"), "promo");
  assert.equal(familyOf("Year 2026 recap"), "year 2026 recap");
  assert.equal(familyOf("42"), "42");
});

test("others leaves out the project and its copies", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-house-"));
  try {
    const house = createHouseMemory(directory);
    const moments = [{ scene: "s", t: 1, sig: { backdrop: 0, items: [] } }];
    await house.record({ projectId: "a", name: "Promo", rev: 3, moments });
    await house.record({ projectId: "b", name: "Promo [copy]", rev: 1, moments });
    await house.record({ projectId: "c", name: "Recap", rev: 9, moments });
    const seen = await house.others("a", "Promo");
    assert.deepEqual(seen.map((entry) => entry.projectId), ["c"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
