// The step log (agent/step-log.mjs): pure functions, called directly.
import assert from "node:assert/strict";
import { test } from "node:test";
import { footageMove } from "./footage-finder/step.mjs";
import { nextMove } from "./agent/brief.mjs";
import { finishLog, logCall, stepNameOf, stepRanges, stepRows, stepsLine, stepsTable, WAIT_GAP_MS } from "./agent/step-log.mjs";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

test("a call counts toward the step open when it arrived, with the thinking time before it", () => {
  let log = logCall(null, "brief", 0, 2 * SECOND);
  log = logCall(log, "brief", 30 * SECOND, 31 * SECOND);
  log = logCall(log, "references", 60 * SECOND, 60 * SECOND + 500);
  log = logCall(log, "references", 5 * MINUTE, 5 * MINUTE + 10 * SECOND);
  assert.deepEqual(stepRows(log), [
    { name: "brief", calls: 2, seconds: 31, waitSeconds: 0 },
    { name: "references", calls: 2, seconds: 279, waitSeconds: 0 },
  ]);
  assert.equal(stepsLine(log), "steps: brief 1 min 2 calls · references 5 min 2 calls");
});

test("a step the agent keeps switching between keeps its time: the steps add up to the wall time", () => {
  let build = null;
  let alternating = null;
  for (let index = 0; index < 5; index += 1) {
    const at = index * 125 * SECOND;
    alternating = logCall(alternating, "build", at, at + 2 * SECOND);
    alternating = logCall(alternating, "review", at + 64 * SECOND, at + 67 * SECOND);
  }
  for (let index = 0; index < 10; index += 1) build = logCall(build, "build", index * 62 * SECOND, index * 62 * SECOND + 2 * SECOND);
  const seconds = stepRows(alternating).reduce((sum, row) => sum + row.seconds, 0);
  assert.equal(seconds, 4 * 125 + 67, "from the first call's start to the last call's end");
  assert.match(stepsLine(alternating), /^steps: build [45] min 5 calls · review [45] min 5 calls$/);
  assert.equal(stepRows(build)[0].seconds, 9 * 62 + 2);
});

test("a gap of more than 10 minutes inside a step is waiting on the person, kept apart", () => {
  let log = logCall(null, "rough", 0, SECOND);
  log = logCall(log, "rough", WAIT_GAP_MS, WAIT_GAP_MS + SECOND);
  assert.equal(stepRows(log)[0].waitSeconds, 0, "exactly 10 minutes is still kino's time");
  log = logCall(log, "rough", WAIT_GAP_MS + 60 * MINUTE, WAIT_GAP_MS + 60 * MINUTE + 4 * SECOND);
  const [row] = stepRows(log);
  assert.equal(row.calls, 3);
  assert.equal(row.waitSeconds, 3600 - 1);
  assert.equal(row.seconds, 600 + 1 + 4, "the wait is not counted as kino's time");
  assert.equal(stepsLine(log), "steps: rough 10 min 3 calls (waited 60 min)");
  assert.equal(stepsTable(log).length, 3, "a header, one row and the total");
});

test("a step's name comes from status's step line; the call names the passes after the brief steps", () => {
  assert.equal(stepNameOf(nextMove({}, {})), "brief", "the real first step");
  assert.equal(stepNameOf(footageMove(undefined)), "footage");
  const names = (step, context) => stepNameOf({ step }, context);
  assert.equal(names("find 2 references (inspire)"), "references");
  assert.equal(names("study ref1 +1 (look)"), "references");
  assert.equal(names("write 5 treatments"), "treatments");
  assert.equal(names("ask their treatment pick"), "treatments");
  assert.equal(names("save the signature and spine"), "signature");
  assert.equal(names("lock direction: spine + style bible (31 layers built)"), "lock");
  assert.equal(names("check material: notes needs"), "needs");
  assert.equal(names("ask board, then build on"), "board");
  assert.equal(names("notes set_plan, board a move per shot, ask board, then build"), "board");
  assert.equal(names("check, then ask sound again"), "sound");
  assert.equal(names("follow the plan, then ask rough"), "build", "the stop is only named once it is asked");
  assert.equal(names("end your turn until they answer", { waiting: "color" }), "color");
  assert.equal(names("follow the plan", { verb: "notes", input: { action: "checkpoint", id: "rough" } }), "rough");
  assert.equal(names("build on", { waiting: "critique" }), "critic");
  assert.equal(names("build on", { verb: "look", input: { mode: "viewer" } }), "viewer");
  assert.equal(names("build on", { verb: "look", input: { mode: "critique" } }), "critic");
  assert.equal(names("build on", { verb: "look", input: { mode: "review" } }), "review");
  assert.equal(names("build on", { verb: "render", input: { action: "start", quality: "final" } }), "final");
  assert.equal(names("build on", { verb: "edit", input: {} }), "build");
  for (const id of ["__proto__", "toString", "constructor", 5, null]) {
    assert.equal(names("build on", { verb: "notes", input: { action: "checkpoint", id } }), "build", `checkpoint id ${String(id)} names no stop`);
    assert.equal(names("build on", { waiting: id }), "build", `a waiting kind ${String(id)} names no stop`);
  }
  assert.equal(stepRows(logCall(null, "toString", 0, SECOND)).length, 0, "a name outside the step names is not logged");
});

test("ranges per step come from finished videos only, and say how many runs they rest on", () => {
  const run = (briefMinutes) => finishLog(logCall(logCall(null, "brief", 0, briefMinutes * MINUTE), "final", 0, 0), "2026-11-11T10:00:00.000Z");
  const unfinished = logCall(null, "brief", 0, 99 * MINUTE);
  const few = stepRanges([run(2), run(4), unfinished]);
  assert.deepEqual([few.runs, few.enough], [2, false]);
  assert.match(few.text, /^from 2 finished runs, too few for a range \(5 needed\): brief 2 to 4 min/);
  const enough = stepRanges([run(2), run(4), run(3), run(8), run(5), unfinished]);
  assert.deepEqual([enough.runs, enough.enough, enough.steps.brief], [5, true, { runs: 5, min: 2, max: 8 }]);
  assert.match(enough.text, /^brief 2 to 8 min.* \(from 5 finished runs\)$/);
  const damaged = { steps: {}, order: {}, finishedAt: "2026-11-11T10:00:00.000Z" };
  assert.deepEqual(stepRows(damaged), [], "a log whose order is not a list reads as empty");
  assert.equal(stepRanges([damaged, run(2)]).runs, 2);
});
