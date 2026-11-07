// The top bar's "needs you" words (needsBar.js) and the shades a loading picture shows
// (resolveCells.js).
import assert from "node:assert/strict";
import { test } from "node:test";
import { needsBar } from "./dashboard/needsBar.js";
import { asciiCells } from "./dashboard/resolveCells.js";

const approval = (id, kind, name = "Nova") => ({ type: "approval", approval: { id, kind, summary: "a final mp4", agent: { id: "a1", name } } });

test("needsBar is null when nothing waits", () => {
  assert.equal(needsBar([]), null);
  assert.equal(needsBar(undefined), null);
});

test("needsBar names the agent, what it asks and how many more wait", () => {
  const bar = needsBar([approval("Q1", "final-render"), approval("Q2", "share-link", "Juno")]);
  assert.deepEqual(bar, { who: "Nova", what: "final render over the frame limit", keys: [["a", "allow"], ["d", "deny"]], more: 1 });
  assert.equal(needsBar([approval("Q1", "final-render"), approval("Q2", "share-link", "Juno")], 1).who, "Juno");
});

test("needsBar words a stop with approve and redo, and names its agent", () => {
  const bar = needsBar([{ type: "stop", projectId: "p", round: { id: "C1", kind: "rough", agentId: "a2", client: "cli" } }], 0, (id) => (id === "a2" ? "Juno" : null));
  assert.deepEqual(bar, { who: "Juno", what: "rough cut", keys: [["a", "approve"], ["d", "redo"]], more: 0 });
});

test("needsBar sends a stop in another project there, with no keys", () => {
  const bar = needsBar([{ type: "elsewhere", projectId: "p2", name: "Promo", round: { id: "C1", kind: "board" } }]);
  assert.equal(bar.who, "Promo");
  assert.match(bar.what, /storyboard · open it there/);
  assert.deepEqual(bar.keys, []);
});

test("asciiCells is the same for the same picture and clears from the top", () => {
  const a = asciiCells("/api/x.png", 9, 14);
  assert.deepEqual(a, asciiCells("/api/x.png", 9, 14));
  assert.notDeepEqual(a.map((row) => row.map((cell) => cell.char).join("")), asciiCells("/api/y.png", 9, 14).map((row) => row.map((cell) => cell.char).join("")));
  assert.equal(a.length, 9);
  assert.ok(a.every((row) => row.length === 14 && row.every((cell) => " .:-=+*#%@".includes(cell.char))));
  // Row r clears between r × 40 ms and r × 40 + 140 ms.
  a.forEach((row, r) => row.forEach((cell) => assert.ok(cell.delay >= r * 40 && cell.delay <= r * 40 + 140)));
});
