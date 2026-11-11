// The step log (agent/step-log.mjs): pure functions, called directly.
import assert from "node:assert/strict";
import { test } from "node:test";
import { footageMove } from "./footage-finder/step.mjs";
import { nextMove } from "./agent/brief.mjs";
import { finishLog, logCall, stepNameOf, stepRanges, stepRows, stepsLine, stepsTable, WAIT_GAP_MS } from "./agent/step-log.mjs";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

test("a call counts toward the step open when it arrived; time runs from the first call to the last call's end", () => {
  let log = logCall(null, "brief", 0, 2 * SECOND);
  log = logCall(log, "brief", 30 * SECOND, 31 * SECOND);
  log = logCall(log, "references", 60 * SECOND, 60 * SECOND + 500);
  log = logCall(log, "references", 5 * MINUTE, 5 * MINUTE + 10 * SECOND);
  assert.deepEqual(stepRows(log), [
    { name: "brief", calls: 2, seconds: 31, waitSeconds: 0 },
    { name: "references", calls: 2, seconds: 250, waitSeconds: 0 },
  ]);
  assert.equal(stepsLine(log), "steps: brief 1 min 2 calls · references 4 min 2 calls");
});

test("a gap of more than 10 minutes inside a step is waiting on the person, kept apart", () => {
  let log = logCall(null, "rough", 0, SECOND);
  log = logCall(log, "rough", WAIT_GAP_MS, WAIT_GAP_MS + SECOND);
  assert.equal(stepRows(log)[0].waitSeconds, 0, "exactly 10 minutes is still kino's time");
  log = logCall(log, "rough", WAIT_GAP_MS + 60 * MINUTE, WAIT_GAP_MS + 60 * MINUTE + 4 * SECOND);
  const [row] = stepRows(log);
  assert.equal(row.calls, 3);
  assert.equal(row.waitSeconds, 3600 - 1);
  assert.equal(row.seconds, 600 + 1 + 4, "the two stretches add up without the wait");
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
});
